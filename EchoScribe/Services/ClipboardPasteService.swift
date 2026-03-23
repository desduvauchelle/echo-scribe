import AppKit
import ApplicationServices

enum PasteResult {
    /// Text was pasted at cursor via simulated Cmd+V
    case pasted
    /// Text was copied to clipboard (accessibility not available for auto-paste)
    case copiedToClipboard
}

enum ClipboardPasteService {

    static var isAccessibilityTrusted: Bool {
        AXIsProcessTrusted()
    }

    /// Requests accessibility permission once. Called at app launch or from
    /// settings — NOT on every dictation attempt (to avoid nagging the user).
    static func requestAccessibilityIfNeeded() {
        guard !AXIsProcessTrusted() else { return }
        let promptKey = "AXTrustedCheckOptionPrompt" as CFString
        let options = [promptKey: true] as CFDictionary
        AXIsProcessTrustedWithOptions(options)
    }

    /// Opens System Settings directly to the Accessibility pane.
    static func openAccessibilitySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Delivers transcribed text to the user. Always succeeds:
    /// - If accessibility is granted: pastes at cursor via Cmd+V, restores clipboard
    /// - If not: copies to clipboard so user can Cmd+V manually
    @MainActor
    static func deliverText(_ text: String) async -> PasteResult {
        if AXIsProcessTrusted() {
            return await pasteAtCursor(text)
        } else {
            copyToClipboard(text)
            return .copiedToClipboard
        }
    }

    /// Copies text to the system clipboard.
    static func copyToClipboard(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    // MARK: - Private

    @MainActor
    private static func pasteAtCursor(_ text: String) async -> PasteResult {
        let pasteboard = NSPasteboard.general
        let previousContents = pasteboard.string(forType: .string)
        let previousChangeCount = pasteboard.changeCount

        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        simulatePaste()

        try? await Task.sleep(for: .milliseconds(300))

        // Restore previous clipboard contents if the paste consumed our entry
        if pasteboard.changeCount == previousChangeCount + 1 {
            pasteboard.clearContents()
            if let previous = previousContents {
                pasteboard.setString(previous, forType: .string)
            }
        }

        return .pasted
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
