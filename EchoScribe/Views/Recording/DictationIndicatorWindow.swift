import AppKit
import SwiftUI

@MainActor
final class DictationIndicatorWindow {
    private var panel: NSPanel?
    private var toastPanel: NSPanel?
    private var toastDismissTask: Task<Void, Never>?

    func show() {
        guard panel == nil else { return }

        let contentView = NSHostingView(rootView: DictationIndicatorView())
        let fittingSize = contentView.fittingSize
        contentView.frame = NSRect(origin: .zero, size: fittingSize)

        let panel = NSPanel(
            contentRect: contentView.frame,
            styleMask: [.nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.contentView = contentView
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.midX - contentView.frame.width / 2
            let y = screenFrame.maxY - contentView.frame.height - 20
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        panel.orderFrontRegardless()
        self.panel = panel
    }

    func dismiss() {
        panel?.close()
        panel = nil
    }

    func showTranscribing() {
        dismiss()

        let contentView = NSHostingView(rootView: TranscribingIndicatorView())
        let fittingSize = contentView.fittingSize
        contentView.frame = NSRect(origin: .zero, size: fittingSize)

        let panel = NSPanel(
            contentRect: contentView.frame,
            styleMask: [.nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.contentView = contentView
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.midX - contentView.frame.width / 2
            let y = screenFrame.maxY - contentView.frame.height - 20
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        panel.orderFrontRegardless()
        self.panel = panel
    }

    /// Shows a brief floating toast (e.g. "Copied to clipboard - Cmd+V to paste")
    /// that auto-dismisses after a few seconds.
    func showToast(_ message: String, duration: TimeInterval = 3.0) {
        dismissToast()

        let contentView = NSHostingView(rootView: ToastView(message: message))
        let fittingSize = contentView.fittingSize
        contentView.frame = NSRect(origin: .zero, size: fittingSize)

        let toast = NSPanel(
            contentRect: contentView.frame,
            styleMask: [.nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        toast.isFloatingPanel = true
        toast.level = .floating
        toast.isOpaque = false
        toast.backgroundColor = .clear
        toast.hasShadow = true
        toast.contentView = contentView
        toast.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.midX - contentView.frame.width / 2
            let y = screenFrame.maxY - contentView.frame.height - 20
            toast.setFrameOrigin(NSPoint(x: x, y: y))
        }

        toast.orderFrontRegardless()
        toastPanel = toast

        toastDismissTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(duration))
            self.dismissToast()
        }
    }

    func dismissToast() {
        toastDismissTask?.cancel()
        toastDismissTask = nil
        toastPanel?.close()
        toastPanel = nil
    }
}

// MARK: - Views

private struct DictationIndicatorView: View {
    @State private var pulseOpacity: Double = 1.0

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(.red)
                .frame(width: 10, height: 10)
                .opacity(pulseOpacity)
                .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: pulseOpacity)

            Text("Dictating...")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.primary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: Capsule())
        .onAppear {
            pulseOpacity = 0.3
        }
    }
}

private struct TranscribingIndicatorView: View {
    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)

            Text("Transcribing...")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.primary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: Capsule())
    }
}

private struct ToastView: View {
    let message: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "doc.on.clipboard")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.secondary)

            Text(message)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.primary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: Capsule())
    }
}
