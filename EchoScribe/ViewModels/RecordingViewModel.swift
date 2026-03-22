import Foundation
import SwiftUI

@MainActor
@Observable
final class RecordingViewModel {
    var isRecording = false
    var liveTranscript = ""
    var audioLevel: Float = 0
    var errorMessage: String?

    private var speechService: SpeechServiceProtocol
    private let pipeline: NoteProcessingPipeline
    private let coordinator: RecordingCoordinator
    private var transcriptionTask: Task<Void, Never>?
    private var audioLevelTask: Task<Void, Never>?

    init(speechService: SpeechServiceProtocol, pipeline: NoteProcessingPipeline, coordinator: RecordingCoordinator) {
        self.speechService = speechService
        self.pipeline = pipeline
        self.coordinator = coordinator
    }

    func toggleRecording() {
        if isRecording {
            Task { @MainActor in await self.stopRecording() }
        } else {
            Task { @MainActor in await self.startRecording() }
        }
    }

    func startRecording() async {
        guard coordinator.canStart(.brain) else { return }

        errorMessage = nil
        liveTranscript = ""
        coordinator.claim(.brain)

        do {
            try await speechService.startRecording()
            isRecording = true

            // Listen for transcription updates
            transcriptionTask = Task {
                for await update in speechService.transcriptionUpdates() {
                    await MainActor.run {
                        self.liveTranscript = update.partialText
                    }
                }
            }

            // Listen for audio level updates
            audioLevelTask = Task {
                for await level in speechService.audioLevelUpdates() {
                    await MainActor.run {
                        self.audioLevel = level
                    }
                }
            }
        } catch {
            coordinator.release()
            errorMessage = error.localizedDescription
        }
    }

    func stopRecording() async {
        transcriptionTask?.cancel()
        transcriptionTask = nil
        audioLevelTask?.cancel()
        audioLevelTask = nil
        audioLevel = 0

        var finalText = await speechService.stopRecording()
        isRecording = false
        coordinator.release()

        // Fallback: if the speech service returned empty but we have live transcript, use that
        if finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !liveTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            finalText = liveTranscript
        }

        guard !finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            liveTranscript = ""
            return
        }

        // Process the transcript through the pipeline
        do {
            try await pipeline.process(rawTranscript: finalText)
            liveTranscript = ""
        } catch {
            errorMessage = "Failed to save note: \(error.localizedDescription)"
        }
    }

    func updateSpeechService(_ service: SpeechServiceProtocol) {
        self.speechService = service
    }
}
