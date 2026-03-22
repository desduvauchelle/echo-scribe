import Foundation

@MainActor
@Observable
final class RecordingCoordinator {
    enum ActiveMode {
        case none
        case brain
        case dictation
    }

    private(set) var activeMode: ActiveMode = .none

    func canStart(_ mode: ActiveMode) -> Bool {
        activeMode == .none
    }

    func claim(_ mode: ActiveMode) {
        activeMode = mode
    }

    func release() {
        activeMode = .none
    }
}
