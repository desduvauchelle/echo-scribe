import AppKit

enum DoublePressKey: String, CaseIterable {
    case option
    case shift
    case control
    case command
    case fn

    var displayName: String {
        switch self {
        case .option: return "Option (⌥)"
        case .shift: return "Shift (⇧)"
        case .control: return "Control (⌃)"
        case .command: return "Command (⌘)"
        case .fn: return "Fn"
        }
    }

    var modifierFlag: NSEvent.ModifierFlags {
        switch self {
        case .option: return .option
        case .shift: return .shift
        case .control: return .control
        case .command: return .command
        case .fn: return .function
        }
    }
}

enum DoublePressAction: String {
    case off
    case voiceToNote
    case transcribe
}

@MainActor
final class DoublePressShortcutService {
    static let shared = DoublePressShortcutService()

    var onDoublePress: (() -> Void)?
    var monitoredKey: DoublePressKey = .option

    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var isRunning = false

    /// Timestamp of the last "key down" transition for the monitored modifier.
    private var lastPressTime: Date?

    /// Previous modifier flags state — used to detect press vs release transitions.
    private var previousFlags: NSEvent.ModifierFlags = []

    /// Maximum interval between two presses to count as a double-press.
    private let threshold: TimeInterval = 0.4

    private init() {}

    func start() {
        guard !isRunning else { return }
        isRunning = true
        lastPressTime = nil
        previousFlags = []

        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlagsChanged(event)
        }

        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlagsChanged(event)
            return event
        }
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

        lastPressTime = nil
        previousFlags = []
    }

    private func handleFlagsChanged(_ event: NSEvent) {
        let currentFlags = event.modifierFlags
        let targetFlag = monitoredKey.modifierFlag

        let wasPressed = previousFlags.contains(targetFlag)
        let isPressed = currentFlags.contains(targetFlag)
        previousFlags = currentFlags

        // Only act on the "key down" transition (flag appeared)
        guard !wasPressed && isPressed else { return }

        let now = Date()

        if let last = lastPressTime, now.timeIntervalSince(last) < threshold {
            // Double-press detected
            lastPressTime = nil
            Task { @MainActor [weak self] in
                self?.onDoublePress?()
            }
        } else {
            lastPressTime = now
        }
    }
}
