import Foundation

@MainActor
@Observable
final class DictationViewModel {
    var isRecording = false
    var liveTranscript = ""
    var errorMessage: String?

    private var speechService: SpeechServiceProtocol
    private let coordinator: RecordingCoordinator
    private var transcriptionTask: Task<Void, Never>?

    init(speechService: SpeechServiceProtocol, coordinator: RecordingCoordinator) {
        self.speechService = speechService
        self.coordinator = coordinator
    }

    func startDictation() async {
        guard coordinator.canStart(.dictation) else { return }
        guard !isRecording else { return }

        errorMessage = nil
        liveTranscript = ""
        coordinator.claim(.dictation)

        do {
            try await speechService.startRecording()
            isRecording = true

            transcriptionTask = Task {
                for await update in speechService.transcriptionUpdates() {
                    await MainActor.run {
                        self.liveTranscript = update.partialText
                    }
                }
            }
        } catch {
            coordinator.release()
            errorMessage = error.localizedDescription
        }
    }

    func stopDictationAndPaste() async {
        guard isRecording else { return }

        transcriptionTask?.cancel()
        transcriptionTask = nil

        let finalText = await speechService.stopRecording()
        isRecording = false
        coordinator.release()

        let trimmed = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            liveTranscript = ""
            return
        }

        let success = await ClipboardPasteService.pasteText(trimmed)
        if !success {
            errorMessage = "Accessibility permission required for paste-at-cursor"
        }
        liveTranscript = ""
    }

    func updateSpeechService(_ service: SpeechServiceProtocol) {
        self.speechService = service
    }
}
