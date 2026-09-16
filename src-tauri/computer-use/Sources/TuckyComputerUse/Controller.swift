import AppKit
import ApplicationServices
import ComputerUseCore
import ScreenCaptureKit

struct ToolRequest: Decodable {
    var id: String
    var tool: String
    var revision: String?
    var element: Int?
    var text: String?
    var key: String?
    var direction: String?
}

@MainActor
final class Controller {
    let app: NSRunningApplication
    let stop: StopToken
    var policy: SessionPolicy
    var elements: [Int: AXUIElement] = [:]
    var observedWindow: AXUIElement?
    var labels: [Int: String] = [:]
    var escapeMonitor: Any?

    init(pid: pid_t, allowActions: Bool, stop: StopToken) throws {
        guard pid > 0, pid != getpid(), let app = NSRunningApplication(processIdentifier: pid) else {
            throw ControlError("app_missing", "The selected application is not running.")
        }
        self.app = app
        self.stop = stop
        self.policy = SessionPolicy(allowActions: allowActions)
        escapeMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == 53 { stop.stop() }
        }
    }

    func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    func string(_ element: AXUIElement, _ name: String) -> String {
        guard let value = attribute(element, name) else { return "" }
        return String(String(describing: value).prefix(2000))
    }
    func children(_ element: AXUIElement, _ name: String = "AXChildren") -> [AXUIElement] {
        attribute(element, name) as? [AXUIElement] ?? []
    }
    func frame(_ element: AXUIElement) -> CGRect? {
        guard let p = attribute(element, "AXPosition"), let s = attribute(element, "AXSize"),
              CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point),
              AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }
    func checkTarget() throws {
        try stop.check()
        guard !app.isTerminated, NSRunningApplication(processIdentifier: app.processIdentifier)?.launchDate == app.launchDate else {
            throw ControlError("app_exited", "The selected application exited. Start a new session.")
        }
        guard AXIsProcessTrusted() else {
            throw ControlError("accessibility_required", "Allow Accessibility for the host running this helper in System Settings, then retry.")
        }
    }
    func window() throws -> AXUIElement {
        try checkTarget()
        let root = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.25)
        // Same opt-in used by Tucky's focus reader; only the explicitly selected app.
        for name in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
            _ = AXUIElementSetAttributeValue(root, name as CFString, kCFBooleanTrue)
        }
        let windows = children(root, "AXWindows")
        if let observedWindow, windows.contains(where: { CFEqual($0, observedWindow) }) { return observedWindow }
        guard let window = windows.first else { throw ControlError("window_missing", "No accessible window. Open a window and observe again.") }
        return window
    }
    func fingerprint(_ element: AXUIElement) -> String {
        ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXIdentifier"].map { string(element, $0) }.joined(separator: "\u{1f}")
    }
    func observe() throws -> [String: Any] {
        let win = try window()
        observedWindow = win
        elements.removeAll(); labels.removeAll()
        var nodes: [[String: Any]] = []
        var visited: Set<CFHashCode> = []
        let started = ProcessInfo.processInfo.systemUptime
        var truncated = false
        func walk(_ element: AXUIElement, parent: Int?, depth: Int) throws {
            try stop.check()
            guard nodes.count < 500, depth < 30, ProcessInfo.processInfo.systemUptime - started < 3 else {
                truncated = true; return
            }
            guard visited.insert(CFHash(element)).inserted else { return }
            let index = nodes.count
            let role = string(element, "AXRole")
            let secure = string(element, "AXSubrole") == "AXSecureTextField"
            var settable = DarwinBoolean(false)
            _ = AXUIElementIsAttributeSettable(element, "AXValue" as CFString, &settable)
            var actionNames: CFArray?
            _ = AXUIElementCopyActionNames(element, &actionNames)
            var node: [String: Any] = ["id": index, "role": role,
                "title": string(element, "AXTitle"), "label": string(element, "AXDescription"),
                "identifier": string(element, "AXIdentifier"),
                "value": secure ? "[secure]" : string(element, "AXValue"),
                "url": secure ? "" : string(element, "AXURL"),
                "settable": !secure && settable.boolValue,
                "actions": (actionNames as? [String]) ?? [],
                "focused": (attribute(element, "AXFocused") as? Bool) ?? false]
            if let parent { node["parent"] = parent }
            nodes.append(node)
            if !secure { elements[index] = element; labels[index] = fingerprint(element) }
            if !secure {
                for child in children(element) { try walk(child, parent: index, depth: depth + 1) }
            }
        }
        try walk(win, parent: nil, depth: 0)
        return ["pid": app.processIdentifier, "app": app.localizedName ?? "", "window": string(win, "AXTitle"),
                "revision": policy.observe(now: ProcessInfo.processInfo.systemUptime), "nodes": nodes,
                "truncated": truncated, "frontmost_pid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1]
    }
    func target(_ index: Int?) throws -> AXUIElement {
        guard let index, let element = elements[index] else {
            throw ControlError("element_missing", "Choose an element from the latest observation.")
        }
        var owner: pid_t = 0
        guard AXUIElementGetPid(element, &owner) == .success, owner == app.processIdentifier,
              labels[index] == fingerprint(element) else {
            throw ControlError("stale_element", "That control changed. Observe again.")
        }
        guard (attribute(element, "AXEnabled") as? Bool) != false else {
            throw ControlError("disabled", "That control is disabled.")
        }
        return element
    }
    func checked(_ result: AXError) throws {
        guard result == .success else {
            throw ControlError("ax_action_failed", "Accessibility action returned \(result.rawValue). Observe before retrying; it may have partially executed.")
        }
    }
    func yieldIfUserActive() throws {
        try checkTarget()
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
           CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .keyDown) < 1 {
            throw ControlError("user_active", "You are typing in this app. Computer use paused.")
        }
    }
    /// No global CGEventPost, cursor warp, clipboard, or app.activate fallback.
    func key(_ code: CGKeyCode, flags: CGEventFlags = [], text: [UniChar]? = nil) throws {
        try yieldIfUserActive()
        let root = AXUIElementCreateApplication(app.processIdentifier)
        guard let observedWindow,
              let focused = attribute(root, "AXFocusedWindow"), CFEqual(focused, observedWindow) else {
            throw ControlError("window_not_focused", "The selected app's keyboard target changed. Observe again; no input sent.")
        }
        guard let source = CGEventSource(stateID: .privateState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
            throw ControlError("input_failed", "Could not create keyboard input.")
        }
        down.flags = flags; up.flags = flags
        if let text {
            down.keyboardSetUnicodeString(stringLength: text.count, unicodeString: text)
            up.keyboardSetUnicodeString(stringLength: text.count, unicodeString: text)
        }
        down.postToPid(app.processIdentifier)
        up.postToPid(app.processIdentifier)
    }
    func screenshot() async throws -> [String: Any] {
        let win = try window()
        guard CGPreflightScreenCaptureAccess() else {
            throw ControlError("screen_recording_required", "Allow Screen Recording for this helper's host in System Settings.")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let bounds = frame(win)
        let matches = content.windows.filter { candidate in
            candidate.owningApplication?.processID == app.processIdentifier &&
            (bounds.map { abs(candidate.frame.minX - $0.minX) < 2 && abs(candidate.frame.minY - $0.minY) < 2 && abs(candidate.frame.width - $0.width) < 2 && abs(candidate.frame.height - $0.height) < 2 } ?? false)
        }
        guard matches.count == 1, let selected = matches.first else {
            throw ControlError("window_ambiguous", "Cannot match the selected window to a screenshot safely.")
        }
        let config = SCStreamConfiguration()
        config.width = max(1, Int(selected.frame.width)); config.height = max(1, Int(selected.frame.height))
        config.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: selected), configuration: config)
        try stop.check()
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw ControlError("capture_failed", "Could not encode the window screenshot.")
        }
        return ["png_base64": data.base64EncodedString(), "width": image.width, "height": image.height]
    }
    func handle(_ request: ToolRequest) async throws -> [String: Any] {
        if request.tool == "status" {
            return ["accessibility": AXIsProcessTrusted(), "screen_recording": CGPreflightScreenCaptureAccess(),
                    "pid": app.processIdentifier, "allow_actions": policy.allowActions]
        }
        if request.tool == "stop" { stop.stop(); return ["stopped": true] }
        if request.tool == "observe" { return try observe() }
        if request.tool == "screenshot" { return try await screenshot() }
        guard ["click", "set_value", "type", "key", "scroll"].contains(request.tool) else {
            throw ControlError("unknown_tool", "Unknown computer-use tool.")
        }
        try checkTarget()
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let cursor = CGEvent(source: nil)?.location
        try policy.consume(request.revision, now: ProcessInfo.processInfo.systemUptime,
                           targetIsFrontmost: front == app.processIdentifier,
                           idleSeconds: min(CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .keyDown),
                                            CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .leftMouseDown)))
        guard let observedWindow, CFEqual(try window(), observedWindow) else {
            throw ControlError("window_changed", "The selected window changed. Observe again.")
        }
        var tier = "accessibility"
        switch request.tool {
        case "click":
            try checked(AXUIElementPerformAction(try target(request.element), "AXPress" as CFString))
        case "set_value":
            let element = try target(request.element)
            guard let text = request.text, text.utf16.count <= 4096 else { throw ControlError("invalid_text", "Provide at most 4096 text characters.") }
            try checked(AXUIElementSetAttributeValue(element, "AXValue" as CFString, text as CFString))
            guard (attribute(element, "AXValue") as? String) == text else {
                throw ControlError("value_not_verified", "The app did not report the requested text. Observe before retrying.")
            }
        case "type":
            guard let text = request.text, !text.isEmpty, text.utf16.count <= 512,
                  !text.contains(where: { $0.isNewline || $0 == "\t" }) else {
                throw ControlError("invalid_text", "Type accepts 1–512 characters without Return or Tab. Use key explicitly to submit.")
            }
            tier = "targeted_input_unverified"
            for character in text {
                try key(0, text: Array(String(character).utf16))
                try await Task.sleep(nanoseconds: 5_000_000)
            }
        case "key":
            tier = "targeted_input_unverified"
            switch request.key {
            case "address_bar": try key(37, flags: .maskCommand)
            case "select_all": try key(0, flags: .maskCommand)
            case "return": try key(36)
            case "tab": try key(48)
            case "escape": try key(53)
            default: throw ControlError("invalid_key", "Supported keys: address_bar, select_all, return, tab, escape.")
            }
        case "scroll":
            let actions = ["up": "AXScrollUpByPage", "down": "AXScrollDownByPage"]
            guard let direction = request.direction, let action = actions[direction] else { throw ControlError("invalid_direction", "Use up or down.") }
            try checked(AXUIElementPerformAction(try target(request.element), action as CFString))
        default: break
        }
        try await Task.sleep(nanoseconds: 120_000_000)
        let focusChanged = NSWorkspace.shared.frontmostApplication?.processIdentifier != front
        let cursorChanged = CGEvent(source: nil)?.location != cursor
        if focusChanged {
            stop.stop()
            throw ControlError("focus_changed", "Foreground app changed during the action. Stopped; inspect the result before continuing.")
        }
        return ["delivery": tier, "focus_changed": focusChanged, "cursor_changed": cursorChanged,
                "state": try observe()]
    }
}
