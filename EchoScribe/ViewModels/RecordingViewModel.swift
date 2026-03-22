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
    private var transcriptionTask: Task<Void, Never>?

    init(speechService: SpeechServiceProtocol, pipeline: NoteProcessingPipeline) {
        self.speechService = speechService
        self.pipeline = pipeline
    }

    func toggleRecording() {
        if isRecording {
            Task { @MainActor in await self.stopRecording() }
        } else {
            Task { @MainActor in await self.startRecording() }
        }
    }

    func startRecording() async {
        errorMessage = nil
        liveTranscript = ""

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
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func stopRecording() async {
        transcriptionTask?.cancel()
        transcriptionTask = nil

        let finalText = await speechService.stopRecording()
        isRecording = false

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
