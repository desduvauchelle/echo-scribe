import SwiftUI

@main
struct EchoScribeApp: App {
    @StateObject private var supervisor = CoreSupervisor()

    var body: some Scene {
        WindowGroup("Echo Scribe") {
            WebViewHost(supervisor: supervisor)
                .frame(minWidth: 900, minHeight: 600)
        }

        MenuBarExtra {
            MenuBarView(supervisor: supervisor)
        } label: {
            StatusDotView(healthy: supervisor.coreStatus?.healthy ?? false)
        }
        .menuBarExtraStyle(.menu)
    }
}

// Simple status dot view for the menubar label
struct StatusDotView: View {
    let healthy: Bool

    var body: some View {
        Image(systemName: "circle.fill")
            .foregroundStyle(healthy ? .green : .gray)
            .imageScale(.small)
    }
}
