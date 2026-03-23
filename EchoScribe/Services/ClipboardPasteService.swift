import AppKit
import ApplicationServices

enum ClipboardPasteService {

    static var isAccessibilityTrusted: Bool {
        AXIsProcessTrusted()
    }

    /// Prompts for accessibility permission only if the app has never been added.
    /// If the app is already in the list (but stale from a rebuild), the system
    /// dialog cannot help — the user must toggle it off/on manually.
    static func requestAccessibilityPermission() {
        let promptKey = "AXTrustedCheckOptionPrompt" as CFString
        let options = [promptKey: true] as CFDictionary
        AXIsProcessTrustedWithOptions(options)
    }

    /// Opens System Settings directly to the Accessibility pane so the user
    /// can toggle the permission off and back on after a rebuild.
    static func openAccessibilitySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    @MainActor
    static func pasteText(_ text: String) async -> Bool {
        guard AXIsProcessTrusted() else {
            // Open settings directly instead of showing the system prompt repeatedly.
            // The system prompt only helps on first-time setup; after rebuilds the user
            // needs to toggle the existing entry off/on in System Settings.
            openAccessibilitySettings()
            return false
        }

        let pasteboard = NSPasteboard.general
        let previousContents = pasteboard.string(forType: .string)
        let previousChangeCount = pasteboard.changeCount

        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        simulatePaste()

        try? await Task.sleep(for: .milliseconds(300))

        if pasteboard.changeCount == previousChangeCount + 1 {
            pasteboard.clearContents()
            if let previous = previousContents {
                pasteboard.setString(previous, forType: .string)
            }
        }

        return true
    }

    private static func simulatePaste() {
        let source = CGEventSource(stateID: .hidSystemState)

        guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0x09, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0x09, keyDown: false) else {
            return
        }

        keyDown.flags = .maskCommand
        keyUp.flags = .maskCommand

        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)
    }
}
