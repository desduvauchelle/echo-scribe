import Foundation

enum SystemShortcutNames {
    /// Maps symbolic hotkey integer IDs from com.apple.symbolichotkeys.plist
    /// to human-readable names. These IDs are stable across macOS versions.
    static let names: [Int: String] = [
        // Focus shortcuts
        7: "Move focus to menu bar",
        8: "Move focus to Dock",
        9: "Move focus to active window",
        10: "Move focus to window toolbar",
        11: "Move focus to floating window",
        12: "Move focus to status menus",
        13: "Toggle Dock hiding",
        27: "Move focus to window drawer",

        // Mission Control / Spaces
        32: "Mission Control",
        33: "Application Windows",
        34: "Mission Control (Slow Motion)",
        35: "Application Windows (Slow Motion)",
        36: "Show Desktop",
        37: "Show Desktop (Slow Motion)",
        79: "Move left a space",
        80: "Move right a space",
        81: "Switch to Desktop 1",
        82: "Switch to Desktop 2",
        83: "Switch to Desktop 3",
        84: "Switch to Desktop 4",

        // Input sources
        60: "Select previous input source",
        61: "Select next input source",

        // Spotlight
        64: "Spotlight",
        65: "Finder Search Window",

        // Screenshots
        28: "Save screenshot as file",
        29: "Copy screenshot to clipboard",
        30: "Save selected area as file",
        31: "Copy selected area to clipboard",
        184: "Screenshot and recording options",

        // Window management
        118: "Move focus to next window",

        // Launchpad & Notification Center
        160: "Launchpad",
        162: "Notification Center",
        163: "Do Not Disturb",
        164: "Accessibility Controls",
    ]

    static func name(forID id: Int) -> String {
        names[id] ?? "System Shortcut (ID: \(id))"
    }
}
