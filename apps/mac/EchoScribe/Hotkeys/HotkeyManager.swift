import AppKit
import HotKey
import os

final class HotkeyManager {
    private let logger = Logger(subsystem: "com.echoscribe.app", category: "HotkeyManager")
    private var hotKey: HotKey?

    var onPressDown: (() -> Void)?
    var onPressUp: (() -> Void)?

    init() {
        register(key: .space, modifiers: [.command, .shift])
    }

    func register(key: Key, modifiers: NSEvent.ModifierFlags) {
        hotKey = nil // release previous
        let hk = HotKey(key: key, modifiers: modifiers)
        hk.keyDownHandler = { [weak self] in
            self?.onPressDown?()
        }
        hk.keyUpHandler = { [weak self] in
            self?.onPressUp?()
        }
        hotKey = hk
        logger.info("Hotkey registered: \(key.description) + modifiers")
    }

    /// Parse a binding string like "cmd+shift+space" into Key + modifiers.
    /// Returns nil if unrecognized.
    func register(binding: String) {
        let parts = binding.lowercased().split(separator: "+").map(String.init)
        var modifiers: NSEvent.ModifierFlags = []
        var keyStr = ""
        for part in parts {
            switch part {
            case "cmd", "command": modifiers.insert(.command)
            case "shift": modifiers.insert(.shift)
            case "opt", "option", "alt": modifiers.insert(.option)
            case "ctrl", "control": modifiers.insert(.control)
            default: keyStr = part
            }
        }
        guard let key = Key(string: keyStr) else {
            logger.error("Unrecognized key in binding: \(binding)")
            return
        }
        register(key: key, modifiers: modifiers)
    }
}
