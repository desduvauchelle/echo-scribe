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

    nonisolated func applyDevice(to audioEngine: AVAudioEngine) {
        let deviceUID = MainActor.assumeIsolated { self.selectedDevice?.uid }
        guard let uid = deviceUID else { return }

        // Access inputNode to ensure it's created
        let inputNode = audioEngine.inputNode
        guard let audioUnit = inputNode.audioUnit else { return }

        // Find the CoreAudio device ID for this UID
        guard let deviceID = Self.coreAudioDeviceIDStatic(for: uid) else { return }

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
            print("[AudioDeviceManager] Failed to set device \(uid): \(status)")
        }
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
