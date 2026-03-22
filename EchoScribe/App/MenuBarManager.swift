import AppKit
import SwiftUI

@MainActor
@Observable
final class MenuBarManager {
    private var statusItem: NSStatusItem?
    private var recordingViewModel: RecordingViewModel?

    var isMenuBarEnabled = false {
        didSet {
            if isMenuBarEnabled {
                setupStatusItem()
            } else {
                removeStatusItem()
            }
        }
    }

    func configure(recordingViewModel: RecordingViewModel) {
        self.recordingViewModel = recordingViewModel
    }

    private func setupStatusItem() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        updateIcon(item: item, isRecording: false)
        item.menu = buildMenu()
        statusItem = item
    }

    private func removeStatusItem() {
        if let item = statusItem {
            NSStatusBar.system.removeStatusItem(item)
            statusItem = nil
        }
    }

    func updateRecordingState(isRecording: Bool) {
        guard let item = statusItem else { return }
        updateIcon(item: item, isRecording: isRecording)
        item.menu = buildMenu()
    }

    private func updateIcon(item: NSStatusItem, isRecording: Bool) {
        if let button = item.button {
            let symbolName = isRecording ? "mic.fill" : "mic"
            let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: "Echo Scribe")
            image?.isTemplate = !isRecording
            if isRecording {
                button.contentTintColor = .red
            } else {
                button.contentTintColor = nil
            }
            button.image = image
        }
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        let isRecording = recordingViewModel?.isRecording ?? false

        let toggleItem = NSMenuItem(
            title: isRecording ? "Stop Recording" : "Start Recording",
            action: #selector(AppDelegate.toggleRecording),
            keyEquivalent: ""
        )
        menu.addItem(toggleItem)

        menu.addItem(.separator())

        let showItem = NSMenuItem(
            title: "Show Echo Scribe",
            action: #selector(AppDelegate.showMainWindow),
            keyEquivalent: ""
        )
        menu.addItem(showItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(
            title: "Quit Echo Scribe",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        menu.addItem(quitItem)

        return menu
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    static var toggleRecordingHandler: (() -> Void)?
    static var showWindowHandler: (() -> Void)?

    @objc static func toggleRecording() {
        toggleRecordingHandler?()
    }

    @objc static func showMainWindow() {
        NSApplication.shared.activate(ignoringOtherApps: true)
        showWindowHandler?()
    }
}
