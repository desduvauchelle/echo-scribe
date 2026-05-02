import Foundation
import Combine

@MainActor
final class AppState: ObservableObject {
    let pipeline: VoiceToTextPipeline
    private var cancellables = Set<AnyCancellable>()

    init(supervisor: CoreSupervisor) {
        pipeline = VoiceToTextPipeline()

        // Wire up pipeline when sidecar port becomes available
        supervisor.$port
            .compactMap { $0 }
            .first()
            .sink { [weak self] port in
                Task { @MainActor [weak self] in
                    self?.pipeline.setup(port: port)
                }
            }
            .store(in: &cancellables)

        // Re-register hotkey when settings change
        pipeline.rpcClient.settingsChanged
            .receive(on: RunLoop.main)
            .sink { [weak self] settings in
                self?.pipeline.hotkeyManager.register(binding: settings.hotkeyBinding)
            }
            .store(in: &cancellables)
    }
}
