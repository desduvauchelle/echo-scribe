import AppKit
import ApplicationServices

/// A development companion, deliberately separate from Tucky's dictation windows.
@MainActor
final class DemoPanel: NSObject, NSWindowDelegate {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 430),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    let output = NSTextView()
    let status = NSTextField(wrappingLabelWithString: "")
    var process: Process?
    var timer: Timer?
    var start: NSButton!
    var stop: NSButton!

    func show() {
        window.title = "Tucky · Computer Use Prototype"
        window.isReleasedWhenClosed = false
        window.delegate = self
        let title = NSTextField(labelWithString: "Try background computer use")
        title.font = .boldSystemFont(ofSize: 22)
        let description = NSTextField(wrappingLabelWithString:
            "Open a clean Chrome session, go to Google, and search for Word. The test checks the results and whether your foreground app or mouse moved. No signed-in browser data is used.")
        let permissions = NSButton(title: "Allow Accessibility…", target: self, action: #selector(grantAccessibility))
        let screen = NSButton(title: "Allow Screenshots…", target: self, action: #selector(grantScreenshots))
        start = NSButton(title: "Run Google test", target: self, action: #selector(run))
        start.bezelStyle = .rounded
        stop = NSButton(title: "Stop", target: self, action: #selector(cancel))
        stop.isEnabled = false
        let buttons = NSStackView(views: [start, stop, permissions, screen])
        buttons.spacing = 10
        output.isEditable = false
        output.isSelectable = true
        output.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        output.autoresizingMask = [.width]
        output.textContainer?.widthTracksTextView = true
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.documentView = output
        scroll.borderType = .bezelBorder
        let stack = NSStackView(views: [title, description, status, buttons, scroll])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor, constant: -24),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 150),
        ])
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
    func refresh() {
        let accessibility = AXIsProcessTrusted()
        status.stringValue = accessibility
            ? "Accessibility ready. Screenshots: \(CGPreflightScreenCaptureAccess() ? "ready" : "optional permission needed")."
            : "First, allow this prototype in System Settings → Privacy & Security → Accessibility."
        start.isEnabled = accessibility && process == nil
    }
    @objc func grantAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }
    @objc func grantScreenshots() {
        _ = CGRequestScreenCaptureAccess()
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
    }
    @objc func run() {
        guard process == nil, AXIsProcessTrusted(),
              let script = Bundle.main.url(forResource: "computer-use-google", withExtension: "py"),
              let executable = Bundle.main.executableURL else { return }
        output.string = "Starting a clean browser session…\n"
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        child.arguments = [script.path, "--helper", executable.path]
        let pipe = Pipe()
        child.standardOutput = pipe
        child.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in self?.append(text) }
        }
        child.terminationHandler = { [weak self] task in
            pipe.fileHandleForReading.readabilityHandler = nil
            Task { @MainActor in
                self?.append(task.terminationStatus == 0
                    ? "\nGoogle search and background checks passed. The browser remains open for review.\n"
                    : "\nTest not passed or stopped. Details and evidence path are above.\n")
                self?.process = nil
                self?.stop.isEnabled = false
                self?.refresh()
            }
        }
        do {
            try child.run()
            process = child
            start.isEnabled = false
            stop.isEnabled = true
        } catch {
            append("Couldn't start the test: \(error.localizedDescription)\n")
        }
    }
    func append(_ text: String) {
        output.textStorage?.append(NSAttributedString(string: text))
        output.scrollToEndOfDocument(nil)
    }
    @objc func cancel() {
        process?.terminate()
        append("Stopping…\n")
    }
    func windowWillClose(_ notification: Notification) {
        timer?.invalidate()
        process?.terminate()
        NSApplication.shared.terminate(nil)
    }
}
