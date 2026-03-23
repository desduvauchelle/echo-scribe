import AppKit
import Foundation

@MainActor
@Observable
final class DictationViewModel {
    var isRecording = false
    var isTranscribing = false
    var liveTranscript = ""
    var errorMessage: String?
    /// Set after stop — the UI layer reads this to show a toast.
    var lastPasteResult: PasteResult?

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
        lastPasteResult = nil
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

        isRecording = false
        isTranscribing = true

        // Get final text BEFORE cancelling the transcription task
        // so the speech service can flush any remaining audio
        var finalText = await speechService.stopRecording()
        isTranscribing = false
        coordinator.release()

        // Cancel transcription task AFTER getting final text
        transcriptionTask?.cancel()
        transcriptionTask = nil

        // Fallback: if speech service returned empty but live transcript has content, use it
        if finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !liveTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            finalText = liveTranscript
        }

        let trimmed = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            liveTranscript = ""
            return
        }

        let result = await ClipboardPasteService.deliverText(trimmed)
        lastPasteResult = result
        liveTranscript = ""
    }

    func updateSpeechService(_ service: SpeechServiceProtocol) {
        self.speechService = service
    }
}
