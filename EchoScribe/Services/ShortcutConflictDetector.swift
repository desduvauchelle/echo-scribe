import Foundation
import AppKit
import KeyboardShortcuts

struct ShortcutConflict: Identifiable {
    let id = UUID()

    enum Source {
        case system(name: String, symbolicID: Int)
        case echoScribe(shortcutName: String)
    }

    let source: Source

    var displayName: String {
        switch source {
        case .system(let name, _):
            return name
        case .echoScribe(let name):
            return "Echo Scribe: \(name)"
        }
    }

    var systemShortcutID: Int? {
        if case .system(_, let id) = source { return id }
        return nil
    }
}

final class ShortcutConflictDetector {

    func detectConflicts(
        for shortcut: KeyboardShortcuts.Shortcut,
        excludingName: KeyboardShortcuts.Name
    ) -> [ShortcutConflict] {
        var conflicts: [ShortcutConflict] = []
        conflicts += detectSystemConflicts(for: shortcut)
        conflicts += detectInternalConflicts(for: shortcut, excludingName: excludingName)
        return conflicts
    }

    // MARK: - System Shortcuts

    private func detectSystemConflicts(
        for shortcut: KeyboardShortcuts.Shortcut
    ) -> [ShortcutConflict] {
        let plistPath = NSHomeDirectory() + "/Library/Preferences/com.apple.symbolichotkeys.plist"

        guard
            let plistData = NSDictionary(contentsOfFile: plistPath),
            let hotkeys = plistData["AppleSymbolicHotKeys"] as? [String: Any]
        else {
            return []
        }

        var conflicts: [ShortcutConflict] = []

        for (idString, value) in hotkeys {
            guard
                let id = Int(idString),
                let dict = value as? [String: Any],
                let enabled = dict["enabled"] as? Bool,
                enabled,
                let valueDict = dict["value"] as? [String: Any],
                let parameters = valueDict["parameters"] as? [Any],
                parameters.count >= 3,
                let keyCode = parameters[1] as? Int,
                let modifiers = parameters[2] as? Int
            else {
                continue
            }

            let systemShortcut = KeyboardShortcuts.Shortcut(
                carbonKeyCode: keyCode,
                carbonModifiers: modifiers
            )

            if systemShortcut == shortcut {
                let name = SystemShortcutNames.name(forID: id)
                conflicts.append(ShortcutConflict(source: .system(name: name, symbolicID: id)))
            }
        }

        return conflicts
    }

    // MARK: - Internal Conflicts

    private func detectInternalConflicts(
        for shortcut: KeyboardShortcuts.Shortcut,
        excludingName: KeyboardShortcuts.Name
    ) -> [ShortcutConflict] {
        let allNames: [KeyboardShortcuts.Name] = [.toggleRecording, .dictationMode]
        var conflicts: [ShortcutConflict] = []

        for name in allNames where name != excludingName {
            if let existing = KeyboardShortcuts.getShortcut(for: name), existing == shortcut {
                let displayName: String
                switch name {
                case .toggleRecording: displayName = "Voice to Note"
                case .dictationMode: displayName = "Transcribe"
                default: displayName = name.rawValue
                }
                conflicts.append(ShortcutConflict(source: .echoScribe(shortcutName: displayName)))
            }
        }

        return conflicts
    }

    // MARK: - Disable System Shortcut

    /// Disables a system shortcut by setting enabled=false in the symbolichotkeys plist.
    /// Some shortcuts take effect immediately; others may require logout.
    func disableSystemShortcut(id: Int) -> Bool {
        let plistPath = NSHomeDirectory() + "/Library/Preferences/com.apple.symbolichotkeys.plist"

        guard
            let plistData = NSMutableDictionary(contentsOfFile: plistPath),
            let hotkeys = plistData["AppleSymbolicHotKeys"] as? NSDictionary,
            let mutableHotkeys = hotkeys.mutableCopy() as? NSMutableDictionary,
            let entry = mutableHotkeys[String(id)] as? NSDictionary,
            let mutableEntry = entry.mutableCopy() as? NSMutableDictionary
        else {
            return false
        }

        mutableEntry["enabled"] = false
        mutableHotkeys[String(id)] = mutableEntry
        plistData["AppleSymbolicHotKeys"] = mutableHotkeys

        let success = plistData.write(toFile: plistPath, atomically: true)

        if success {
            // Trigger preference re-read so some shortcuts take effect without logout
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/defaults")
            process.arguments = ["read", "com.apple.symbolichotkeys"]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try? process.run()
            process.waitUntilExit()
        }

        return success
    }
}
