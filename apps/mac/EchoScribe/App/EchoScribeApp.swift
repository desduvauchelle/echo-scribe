import SwiftUI
import UserNotifications

@main
struct EchoScribeApp: App {
    @StateObject private var supervisor: CoreSupervisor
    @StateObject private var appState: AppState

    init() {
        let supervisor = CoreSupervisor()
        _supervisor = StateObject(wrappedValue: supervisor)
        _appState = StateObject(wrappedValue: AppState(supervisor: supervisor))

        // Request notification permission for error alerts
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    var body: some Scene {
        WindowGroup("Echo Scribe") {
            WebViewHost(supervisor: supervisor)
                .frame(minWidth: 900, minHeight: 600)
        }

        MenuBarExtra {
            MenuBarView(supervisor: supervisor)
        } label: {
            StatusDotView(
                healthy: supervisor.coreStatus?.healthy ?? false,
                recording: appState.pipeline.isRecording
            )
        }
        .menuBarExtraStyle(.menu)
    }
}

struct StatusDotView: View {
    let healthy: Bool
    let recording: Bool

    var body: some View {
        Image(systemName: "circle.fill")
            .foregroundStyle(recording ? .red : (healthy ? .green : .gray))
            .imageScale(.small)
    }
}
