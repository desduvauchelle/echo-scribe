import AVFoundation
import CoreAudio
import AudioToolbox

struct AudioInputDevice: Identifiable, Equatable, Codable {
    let uid: String
    let name: String
    var id: String { uid }
}

@MainActor
@Observable
final class AudioDeviceManager {
    var availableDevices: [AudioInputDevice] = []
    var selectedDevice: AudioInputDevice?

    nonisolated(unsafe) private var listenerBlock: AudioObjectPropertyListenerBlock?
    private var isRecordingActive = false

    init() {
        refreshDevices()
        installDeviceListener()
        resolvePreferredDevice()
    }

    deinit {
        guard let block = listenerBlock else { return }
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        AudioObjectRemovePropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            DispatchQueue.main,
            block
        )
    }

    // MARK: - Public API

    func selectDevice(_ device: AudioInputDevice) {
        selectedDevice = device
        UserDefaults.standard.set(device.uid, forKey: Constants.selectedMicrophoneUID)
    }

    /// Applies the selected device to the audio engine and returns the device's actual hardware format.
    /// The returned format should be used for tap installation since `inputNode.outputFormat` is unreliable.
    nonisolated func applyDevice(to audioEngine: AVAudioEngine) -> AVAudioFormat? {
        let deviceUID = MainActor.assumeIsolated { self.selectedDevice?.uid }
        guard let uid = deviceUID else {
            print("[AudioDeviceManager] applyDevice — no selected device")
            return nil
        }

        // Access inputNode to ensure it's created
        let inputNode = audioEngine.inputNode
        guard let audioUnit = inputNode.audioUnit else {
            print("[AudioDeviceManager] applyDevice — no audioUnit on inputNode")
            return nil
        }

        // Find the CoreAudio device ID for this UID
        guard let deviceID = Self.coreAudioDeviceIDStatic(for: uid) else {
            print("[AudioDeviceManager] applyDevice — could not find CoreAudio device for uid=\(uid)")
            return nil
        }

        var mutableDeviceID = deviceID
        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &mutableDeviceID,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )

        if status != noErr {
            print("[AudioDeviceManager] applyDevice — AudioUnitSetProperty failed: \(status)")
        } else {
            print("[AudioDeviceManager] applyDevice — device set successfully: \(uid)")
        }

        // Query the ACTUAL hardware format directly from CoreAudio
        // inputNode.outputFormat is unreliable (returns cached/default format)
        return Self.getHardwareInputFormat(deviceID: deviceID)
    }

    /// Gets the actual hardware input format for a CoreAudio device.
    nonisolated static func getHardwareInputFormat(deviceID: AudioDeviceID) -> AVAudioFormat? {
        // Get the device's nominal sample rate
        var sampleRate: Float64 = 0
        var srSize = UInt32(MemoryLayout<Float64>.size)
        var srAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        let srStatus = AudioObjectGetPropertyData(deviceID, &srAddress, 0, nil, &srSize, &sampleRate)
        if srStatus != noErr {
            print("[AudioDeviceManager] getHardwareInputFormat — failed to get sample rate: \(srStatus)")
            return nil
        }

        // Get the device's input stream configuration (channel count)
        var configAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var configSize: UInt32 = 0
        let configSizeStatus = AudioObjectGetPropertyDataSize(deviceID, &configAddress, 0, nil, &configSize)
        guard configSizeStatus == noErr, configSize > 0 else {
            print("[AudioDeviceManager] getHardwareInputFormat — failed to get config size: \(configSizeStatus)")
            return nil
        }

        let bufferListMemory = UnsafeMutableRawPointer.allocate(byteCount: Int(configSize), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { bufferListMemory.deallocate() }
        let bufferListPointer = bufferListMemory.bindMemory(to: AudioBufferList.self, capacity: 1)

        let configStatus = AudioObjectGetPropertyData(deviceID, &configAddress, 0, nil, &configSize, bufferListPointer)
        guard configStatus == noErr else {
            print("[AudioDeviceManager] getHardwareInputFormat — failed to get config: \(configStatus)")
            return nil
        }

        let bufferList = UnsafeMutableAudioBufferListPointer(bufferListPointer)
        var totalChannels: UInt32 = 0
        for buffer in bufferList {
            totalChannels += buffer.mNumberChannels
        }

        guard totalChannels > 0, sampleRate > 0 else {
            print("[AudioDeviceManager] getHardwareInputFormat — invalid: channels=\(totalChannels), sampleRate=\(sampleRate)")
            return nil
        }

        let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: totalChannels)
        print("[AudioDeviceManager] getHardwareInputFormat — actual HW format: \(sampleRate)Hz, \(totalChannels)ch")
        return format
    }

    /// Gets the hardware format for the currently selected device.
    nonisolated func getSelectedDeviceFormat() -> AVAudioFormat? {
        let deviceUID = MainActor.assumeIsolated { self.selectedDevice?.uid }
        guard let uid = deviceUID,
              let deviceID = Self.coreAudioDeviceIDStatic(for: uid) else { return nil }
        return Self.getHardwareInputFormat(deviceID: deviceID)
    }

    /// Gets the hardware format for the system default input device.
    nonisolated static func getDefaultInputFormat() -> AVAudioFormat? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var deviceID: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address, 0, nil, &size, &deviceID
        )
        guard status == noErr else { return nil }
        return getHardwareInputFormat(deviceID: deviceID)
    }

    func markRecordingStarted() {
        isRecordingActive = true
    }

    func markRecordingStopped() {
        isRecordingActive = false
    }

    func resolvePreferredDevice() {
        // First check if there's a manually selected device that's still available
        if let savedUID = UserDefaults.standard.string(forKey: Constants.selectedMicrophoneUID),
           let device = availableDevices.first(where: { $0.uid == savedUID }) {
            selectedDevice = device
            return
        }

        // Check preference order
        let preferenceOrder = UserDefaults.standard.stringArray(forKey: Constants.microphonePreferenceOrder) ?? []
        for uid in preferenceOrder {
            if let device = availableDevices.first(where: { $0.uid == uid }) {
                selectedDevice = device
                return
            }
        }

        // Fall back to system default
        if let defaultDevice = getDefaultInputDevice() {
            selectedDevice = defaultDevice
        } else {
            selectedDevice = availableDevices.first
        }
    }

    // MARK: - Preference Ordering

    func getPreferenceOrder() -> [AudioInputDevice] {
        let savedUIDs = UserDefaults.standard.stringArray(forKey: Constants.microphonePreferenceOrder) ?? []

        // Build ordered list: saved devices first (in order), then any new devices
        var ordered: [AudioInputDevice] = []
        for uid in savedUIDs {
            if let device = availableDevices.first(where: { $0.uid == uid }) {
                ordered.append(device)
            }
        }
        // Add any devices not yet in the preference list
        for device in availableDevices where !ordered.contains(where: { $0.uid == device.uid }) {
            ordered.append(device)
        }
        return ordered
    }

    func savePreferenceOrder(_ devices: [AudioInputDevice]) {
        let uids = devices.map(\.uid)
        UserDefaults.standard.set(uids, forKey: Constants.microphonePreferenceOrder)
    }

    func resetPreferences() {
        UserDefaults.standard.removeObject(forKey: Constants.microphonePreferenceOrder)
        UserDefaults.standard.removeObject(forKey: Constants.selectedMicrophoneUID)
        resolvePreferredDevice()
    }

    // MARK: - Device Enumeration

    func refreshDevices() {
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        var dataSize: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0, nil,
            &dataSize
        )
        guard status == noErr else { return }

        let deviceCount = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        var deviceIDs = [AudioDeviceID](repeating: 0, count: deviceCount)

        status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0, nil,
            &dataSize,
            &deviceIDs
        )
        guard status == noErr else { return }

        var inputDevices: [AudioInputDevice] = []
        for deviceID in deviceIDs {
            if hasInputChannels(deviceID: deviceID),
               let uid = getDeviceUID(deviceID: deviceID),
               let name = getDeviceName(deviceID: deviceID) {
                // Filter out internal macOS aggregate devices — not real microphones
                if uid.hasPrefix("CADefaultDeviceAggregate") { continue }
                inputDevices.append(AudioInputDevice(uid: uid, name: name))
            }
        }

        availableDevices = inputDevices
    }

    // MARK: - Device Listener

    private func installDeviceListener() {
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.refreshDevices()
                if !self.isRecordingActive {
                    self.resolvePreferredDevice()
                }
            }
        }
        listenerBlock = block

        AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            DispatchQueue.main,
            block
        )
    }

    private func removeDeviceListener() {
        guard let block = listenerBlock else { return }
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        AudioObjectRemovePropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            DispatchQueue.main,
            block
        )
        listenerBlock = nil
    }

    // MARK: - CoreAudio Helpers

    private func hasInputChannels(deviceID: AudioDeviceID) -> Bool {
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )

        var dataSize: UInt32 = 0
        let status = AudioObjectGetPropertyDataSize(deviceID, &propertyAddress, 0, nil, &dataSize)
        guard status == noErr, dataSize > 0 else { return false }

        let bufferListPointer = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: 1)
        defer { bufferListPointer.deallocate() }

        let getStatus = AudioObjectGetPropertyData(deviceID, &propertyAddress, 0, nil, &dataSize, bufferListPointer)
        guard getStatus == noErr else { return false }

        let bufferList = UnsafeMutableAudioBufferListPointer(bufferListPointer)
        var totalChannels: UInt32 = 0
        for buffer in bufferList {
            totalChannels += buffer.mNumberChannels
        }
        return totalChannels > 0
    }

    private func getDeviceUID(deviceID: AudioDeviceID) -> String? {
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        var uid: CFString = "" as CFString
        var dataSize = UInt32(MemoryLayout<CFString>.size)
        let status = AudioObjectGetPropertyData(deviceID, &propertyAddress, 0, nil, &dataSize, &uid)
        guard status == noErr else { return nil }
        return uid as String
    }

    private func getDeviceName(deviceID: AudioDeviceID) -> String? {
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        var name: CFString = "" as CFString
        var dataSize = UInt32(MemoryLayout<CFString>.size)
        let status = AudioObjectGetPropertyData(deviceID, &propertyAddress, 0, nil, &dataSize, &name)
        guard status == noErr else { return nil }
        return name as String
    }

    private nonisolated static func coreAudioDeviceIDStatic(for uid: String) -> AudioDeviceID? {
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        var dataSize: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0, nil,
            &dataSize
        )
        guard status == noErr else { return nil }

        let deviceCount = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        var deviceIDs = [AudioDeviceID](repeating: 0, count: deviceCount)

        status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0, nil,
            &dataSize,
            &deviceIDs
        )
        guard status == noErr else { return nil }

        for deviceID in deviceIDs {
            if getDeviceUIDStatic(deviceID: deviceID) == uid {
                return deviceID
            }
        }
        return nil
    }

    private nonisolated static func getDeviceUIDStatic(deviceID: AudioDeviceID) -> String? {
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        var uid: CFString = "" as CFString
        var dataSize = UInt32(MemoryLayout<CFString>.size)
        let status = AudioObjectGetPropertyData(deviceID, &propertyAddress, 0, nil, &dataSize, &uid)
        guard status == noErr else { return nil }
        return uid as String
    }

    private func coreAudioDeviceID(for uid: String) -> AudioDeviceID? {
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        var dataSize: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0, nil,
            &dataSize
        )
        guard status == noErr else { return nil }

        let deviceCount = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        var deviceIDs = [AudioDeviceID](repeating: 0, count: deviceCount)

        status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0, nil,
            &dataSize,
            &deviceIDs
        )
        guard status == noErr else { return nil }

        for deviceID in deviceIDs {
            if getDeviceUID(deviceID: deviceID) == uid {
                return deviceID
            }
        }
        return nil
    }

    private func getDefaultInputDevice() -> AudioInputDevice? {
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        var deviceID: AudioDeviceID = 0
        var dataSize = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0, nil,
            &dataSize,
            &deviceID
        )
        guard status == noErr else { return nil }

        guard let uid = getDeviceUID(deviceID: deviceID),
              let name = getDeviceName(deviceID: deviceID) else { return nil }
        return AudioInputDevice(uid: uid, name: name)
    }
}
