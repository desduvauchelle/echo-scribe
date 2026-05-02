import AppKit
import ApplicationServices
import os

enum CursorInserterError: Error {
    case accessibilityNotGranted
}

final class CursorInserter {
    private let logger = Logger(subsystem: "com.echoscribe.app", category: "CursorInserter")

    /// Check and prompt for Accessibility permission if needed.
    func ensureAccessibility() -> Bool {
        let trusted = AXIsProcessTrusted()
        if !trusted {
            logger.warning("Accessibility not granted — opening System Settings")
            let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
            NSWorkspace.shared.open(url)
        }
        return trusted
    }

    /// Paste text at the current cursor position in the focused app.
    /// Saves and restores the existing pasteboard contents.
    func insert(text: String) throws {
        guard ensureAccessibility() else { throw CursorInserterError.accessibilityNotGranted }

        let pasteboard = NSPasteboard.general

        // Save existing contents
        let savedItems = pasteboard.pasteboardItems?.compactMap { item -> NSPasteboardItem? in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) {
                    copy.setData(data, forType: type)
                }
            }
            return copy
        } ?? []

        // Write the transcribed text
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        // Synthesize Cmd+V
        let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: 0x09 /* V */, keyDown: true)
        let keyUp   = CGEvent(keyboardEventSource: nil, virtualKey: 0x09 /* V */, keyDown: false)
        keyDown?.flags = .maskCommand
        keyUp?.flags   = .maskCommand
        keyDown?.post(tap: .cghidEventTap)
        keyUp?.post(tap: .cghidEventTap)

        // Brief delay so the target app has time to paste before we restore
        Thread.sleep(forTimeInterval: 0.1)

        // Restore previous pasteboard contents
        pasteboard.clearContents()
        if !savedItems.isEmpty {
            pasteboard.writeObjects(savedItems)
        }

        logger.info("Inserted \(text.count) chars at cursor")
    }
}
