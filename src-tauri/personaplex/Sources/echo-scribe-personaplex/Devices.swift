import CoreAudio
import Foundation

/// CoreAudio input-device enumeration and lookup. Devices are identified to
/// Tucky by UID (stable across reboots) and by name (what the dictation
/// picker stores), so `resolve` accepts either.
enum AudioDevices {
    struct Info {
        let id: AudioDeviceID
        let uid: String
        let name: String
        let inputChannels: Int
        let isDefault: Bool

        var json: [String: Any] {
            ["id": Int(id), "uid": uid, "name": name, "input_channels": inputChannels, "is_default": isDefault]
        }
    }

    private static func address(
        _ selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    private static func string(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var addr = address(selector)
        var size = UInt32(MemoryLayout<CFString?>.size)
        var value: Unmanaged<CFString>?
        let status = withUnsafeMutablePointer(to: &value) { ptr in
            AudioObjectGetPropertyData(id, &addr, 0, nil, &size, ptr)
        }
        guard status == noErr, let cf = value?.takeRetainedValue() else { return nil }
        return cf as String
    }

    private static func inputChannelCount(_ id: AudioDeviceID) -> Int {
        var addr = address(kAudioDevicePropertyStreamConfiguration, scope: kAudioObjectPropertyScopeInput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    static func defaultInputID() -> AudioDeviceID? {
        var addr = address(kAudioHardwarePropertyDefaultInputDevice)
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
        return status == noErr && id != 0 ? id : nil
    }

    /// Every device with at least one input channel, system default first.
    static func inputs() -> [Info] {
        var addr = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else {
            return []
        }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else {
            return []
        }
        let defaultID = defaultInputID()
        var out: [Info] = []
        for id in ids {
            let channels = inputChannelCount(id)
            guard channels > 0 else { continue }
            guard let uid = string(id, kAudioDevicePropertyDeviceUID) else { continue }
            let name = string(id, kAudioObjectPropertyName) ?? uid
            out.append(Info(id: id, uid: uid, name: name, inputChannels: channels, isDefault: id == defaultID))
        }
        return out.sorted { a, b in
            if a.isDefault != b.isDefault { return a.isDefault }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    static func name(for id: AudioDeviceID) -> String? {
        string(id, kAudioObjectPropertyName)
    }

    /// UID first, then exact name, then case-insensitive name.
    static func resolve(_ key: String) -> Info? {
        let list = inputs()
        if let d = list.first(where: { $0.uid == key }) { return d }
        if let d = list.first(where: { $0.name == key }) { return d }
        return list.first { $0.name.caseInsensitiveCompare(key) == .orderedSame }
    }
}
