import AppKit
import Carbon

enum CapsLockMode: String {
    case off
    case voiceToNote
    case transcribe
}

@MainActor
final class CapsLockShortcutService {
    static let shared = CapsLockShortcutService()

    /// Fires on every Caps Lock state change (used for Voice to Note toggle)
    var onCapsLockToggled: (() -> Void)?

    /// Fires when Caps Lock is pressed down (caps on) — used for Transcribe start
    var onCapsLockDown: (() -> Void)?

    /// Fires when Caps Lock is released (caps off) — used for Transcribe stop
    var onCapsLockUp: (() -> Void)?

    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var isRunning = false
    /// True when the CGEvent tap could not be created (accessibility permission missing).
    var eventTapFailed = false

    private init() {}

    /// Starts monitoring Caps Lock. Returns `true` if the event tap was installed
    /// successfully, `false` if accessibility permission is missing.
    @discardableResult
    func start() -> Bool {
        guard !isRunning else { return !eventTapFailed }
        isRunning = true
        eventTapFailed = false

        // Global monitor for when app is not focused
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlagsChanged(event)
        }

        // Local monitor for when app is focused
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlagsChanged(event)
            return event
        }

        installEventTap()
        return !eventTapFailed
    }

    func stop() {
        guard isRunning else { return }
        isRunning = false

        if let globalMonitor {
            NSEvent.removeMonitor(globalMonitor)
            self.globalMonitor = nil
        }

        if let localMonitor {
            NSEvent.removeMonitor(localMonitor)
            self.localMonitor = nil
        }

        removeEventTap()
    }

    private func handleFlagsChanged(_ event: NSEvent) {
        guard event.keyCode == UInt16(kVK_CapsLock) else { return }

        let capsLockOn = event.modifierFlags.contains(.capsLock)

        Task { @MainActor [weak self] in
            guard let self else { return }

            // Toggle mode: fire on every state change
            self.onCapsLockToggled?()

            // Hold mode: fire down/up based on state
            if capsLockOn {
                self.onCapsLockDown?()
            } else {
                self.onCapsLockUp?()
            }
        }
    }

    // MARK: - Event Tap (suppress default Caps Lock behavior)

    private func installEventTap() {
        let eventMask: CGEventMask = 1 << CGEventType.flagsChanged.rawValue

        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: eventMask,
            callback: capsLockEventTapCallback,
            userInfo: nil
        ) else {
            print("CapsLockShortcutService: Could not create event tap. Accessibility permission may be required.")
            eventTapFailed = true
            return
        }

        eventTap = tap
        runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)

        if let source = runLoopSource {
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
        }
    }

    private func removeEventTap() {
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        if let source = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)
        }
        eventTap = nil
        runLoopSource = nil
    }
}

// C-function callback for CGEvent tap — suppresses Caps Lock's default toggle behavior
private func capsLockEventTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard type == .flagsChanged else {
        return Unmanaged.passRetained(event)
    }

    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)

    if keyCode == Int64(kVK_CapsLock) {
        return nil
    }

    return Unmanaged.passRetained(event)
}
