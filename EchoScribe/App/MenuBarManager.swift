import AppKit
import SwiftUI

@MainActor
@Observable
final class MenuBarManager {
    static let shared = MenuBarManager()

    private var statusItem: NSStatusItem?
    private var recordingViewModel: RecordingViewModel?
    private var dictationViewModel: DictationViewModel?

    private init() {}

    func configure(recordingViewModel: RecordingViewModel, dictationViewModel: DictationViewModel) {
        self.recordingViewModel = recordingViewModel
        self.dictationViewModel = dictationViewModel
    }

    func setup() {
        guard statusItem == nil else {
            print("[MenuBar] setup() called but statusItem already exists - skipping")
            return
        }
        print("[MenuBar] setup() creating status item...")
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        updateIcon(item: item, isRecording: false, isDictating: false)
        item.menu = buildMenu()
        statusItem = item
        print("[MenuBar] setup() complete. button=\(item.button != nil), image=\(item.button?.image != nil)")

        // Safety net: verify icon after a short delay
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self, let item = self.statusItem else {
                print("[MenuBar] CRITICAL: statusItem lost after 1s delay!")
                return
            }
            if item.button?.image == nil {
                print("[MenuBar] RECOVERY: image was nil after 1s, re-applying...")
                self.updateIcon(item: item, isRecording: false, isDictating: false)
            } else {
                print("[MenuBar] Verified: icon present after 1s")
            }
        }
    }

    func updateRecordingState(isRecording: Bool) {
        guard let item = statusItem else {
            print("[MenuBar] WARNING: updateRecordingState called but statusItem is nil")
            return
        }
        updateIcon(item: item, isRecording: isRecording, isDictating: dictationViewModel?.isRecording ?? false)
        item.menu = buildMenu()
    }

    func updateDictationState(isDictating: Bool) {
        guard let item = statusItem else {
            print("[MenuBar] WARNING: updateDictationState called but statusItem is nil")
            return
        }
        updateIcon(item: item, isRecording: recordingViewModel?.isRecording ?? false, isDictating: isDictating)
        item.menu = buildMenu()
    }

    private func updateIcon(item: NSStatusItem, isRecording: Bool, isDictating: Bool) {
        if let button = item.button {
            if isRecording {
                let image = NSImage(systemSymbolName: "mic.fill", accessibilityDescription: "Echo Scribe - Recording")
                image?.isTemplate = false
                button.contentTintColor = .red
                button.image = image
            } else if isDictating {
                let image = NSImage(systemSymbolName: "mic.fill", accessibilityDescription: "Echo Scribe - Transcribing")
                image?.isTemplate = false
                button.contentTintColor = .systemBlue
                button.image = image
            } else {
                let image: NSImage?
                if let custom = Bundle.main.image(forResource: "MenuBarIcon") {
                    custom.size = NSSize(width: 16, height: 16)
                    custom.isTemplate = true
                    image = custom
                    print("[MenuBar] Using custom MenuBarIcon from bundle")
                } else {
                    image = NSImage(systemSymbolName: "mic", accessibilityDescription: "Echo Scribe")
                    image?.isTemplate = true
                    print("[MenuBar] FALLBACK: MenuBarIcon not found, using SF Symbol 'mic'")
                }
                button.contentTintColor = nil
                button.image = image
            }
        }
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        let isRecording = recordingViewModel?.isRecording ?? false
        let isDictating = dictationViewModel?.isRecording ?? false

        // Voice Note
        let voiceNoteItem = NSMenuItem(
            title: isRecording ? "Stop Recording" : "Start Voice Note",
            action: #selector(AppDelegate.toggleRecording),
            keyEquivalent: ""
        )
        menu.addItem(voiceNoteItem)

        // Transcribe
        let transcribeItem = NSMenuItem(
            title: isDictating ? "Stop Transcribing" : "Transcribe",
            action: #selector(AppDelegate.toggleDictation),
            keyEquivalent: ""
        )
        menu.addItem(transcribeItem)

        menu.addItem(.separator())

        // Open App
        let showItem = NSMenuItem(
            title: "Open Echo Scribe",
            action: #selector(AppDelegate.showMainWindow),
            keyEquivalent: ""
        )
        menu.addItem(showItem)

        // Settings
        let settingsItem = NSMenuItem(
            title: "Settings\u{2026}",
            action: #selector(AppDelegate.openSettings),
            keyEquivalent: ","
        )
        menu.addItem(settingsItem)

        menu.addItem(.separator())

        // Check for Updates
        let updateItem = NSMenuItem(
            title: "Check for Updates\u{2026}",
            action: #selector(AppDelegate.checkForUpdates),
            keyEquivalent: ""
        )
        menu.addItem(updateItem)

        menu.addItem(.separator())

        // Quit
        let quitItem = NSMenuItem(
            title: "Quit Echo Scribe",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        menu.addItem(quitItem)

        return menu
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    static var toggleRecordingHandler: (() -> Void)?
    static var toggleDictationHandler: (() -> Void)?
    static var showWindowHandler: (() -> Void)?
    static var openSettingsHandler: (() -> Void)?
    static var checkForUpdatesHandler: (() -> Void)?

    private var windowCloseObserver: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        MenuBarManager.shared.setup()

        // Start as accessory (menu bar only, no dock icon)
        NSApp.setActivationPolicy(.accessory)

        // Show the main window on first launch
        showMainWindowWithFocus()

        // Observe window close to hide dock icon when no windows are visible
        windowCloseObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: nil,
            queue: .main
        ) { notification in
            guard let window = notification.object as? NSWindow, window.canBecomeKey else { return }
            // Delay slightly so the window is fully closed before checking
            DispatchQueue.main.async {
                let hasVisibleKeyWindow = NSApp.windows.contains { $0.isVisible && $0.canBecomeKey }
                if !hasVisibleKeyWindow {
                    NSApp.setActivationPolicy(.accessory)
                }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            AppDelegate.showWindowHandler?()
        }
        showMainWindowWithFocus()
        return true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        if let window = NSApp.windows.first(where: { $0.isVisible && $0.canBecomeKey }) {
            window.makeKeyAndOrderFront(nil)
        }
    }

    /// Switches to regular activation policy (shows dock icon), activates the app,
    /// and ensures the main window is key and accepts keyboard input.
    func showMainWindowWithFocus() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
        if let window = NSApp.windows.first(where: { $0.canBecomeKey }) {
            window.makeKeyAndOrderFront(nil)
        }
    }

    @objc static func toggleRecording() {
        toggleRecordingHandler?()
    }

    @objc static func toggleDictation() {
        toggleDictationHandler?()
    }

    @objc static func showMainWindow() {
        (NSApp.delegate as? AppDelegate)?.showMainWindowWithFocus()
        showWindowHandler?()
    }

    @objc static func openSettings() {
        (NSApp.delegate as? AppDelegate)?.showMainWindowWithFocus()
        openSettingsHandler?()
    }

    @objc static func checkForUpdates() {
        checkForUpdatesHandler?()
    }
}
