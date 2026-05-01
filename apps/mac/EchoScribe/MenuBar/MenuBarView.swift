import SwiftUI

struct MenuBarView: View {
    @ObservedObject var supervisor: CoreSupervisor
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack {
            Button("Open Echo Scribe") {
                openWindow(id: "Echo Scribe")
            }
            Divider()
            Button("Quit") {
                supervisor.stop()
                NSApplication.shared.terminate(nil)
            }
        }
    }
}
