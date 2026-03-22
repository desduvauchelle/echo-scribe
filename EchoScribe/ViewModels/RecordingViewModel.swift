import Foundation
import SwiftUI

@MainActor
@Observable
final class RecordingViewModel {
    var isRecording = false
    var isPreparing = false
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
        print("[RecordingVM] toggleRecording() called — isRecording=\(isRecording), isPreparing=\(isPreparing)")
        guard !isPreparing else {
            print("[RecordingVM] toggleRecording() blocked — already preparing")
            return
        }
        if isRecording {
            print("[RecordingVM] → stopping recording")
            Task { @MainActor in await self.stopRecording() }
        } else {
            print("[RecordingVM] → starting recording")
            Task { @MainActor in await self.startRecording() }
        }
    }

    func startRecording() async {
        print("[RecordingVM] startRecording() — checking coordinator (activeMode must be .none)")
        guard coordinator.canStart(.brain) else {
            print("[RecordingVM] startRecording() blocked — coordinator.canStart returned false")
            return
        }

        errorMessage = nil
        liveTranscript = ""
        isPreparing = true
        coordinator.claim(.brain)
        print("[RecordingVM] startRecording() — isPreparing=true, calling speechService.startRecording()")

        // Subscribe to streams BEFORE starting recording to avoid missing early results
        transcriptionTask = Task {
            for await update in speechService.transcriptionUpdates() {
                await MainActor.run {
                    self.liveTranscript = update.partialText
                }
            }
        }

        audioLevelTask = Task {
            for await level in speechService.audioLevelUpdates() {
                await MainActor.run {
                    self.audioLevel = level
                }
            }
        }

        do {
            try await speechService.startRecording()
            isPreparing = false
            isRecording = true
            print("[RecordingVM] startRecording() — speechService ready, isRecording=true")
        } catch {
            isPreparing = false
            coordinator.release()
            transcriptionTask?.cancel()
            transcriptionTask = nil
            audioLevelTask?.cancel()
            audioLevelTask = nil
            errorMessage = error.localizedDescription
            print("[RecordingVM] startRecording() ERROR — \(error)")
        }
    }

    func stopRecording() async {
        print("[RecordingVM] stopRecording() — cancelling tasks, calling speechService.stopRecording()")
        audioLevelTask?.cancel()
        audioLevelTask = nil
        audioLevel = 0

        var finalText = await speechService.stopRecording()
        isRecording = false
        coordinator.release()

        // Cancel transcription task after getting final text (so we don't miss late yields)
        transcriptionTask?.cancel()
        transcriptionTask = nil

        print("[RecordingVM] stopRecording() — finalText length=\(finalText.count): \"\(finalText.prefix(80))\"")

        // Fallback: if the speech service returned empty but we have live transcript, use that
        if finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !liveTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            print("[RecordingVM] stopRecording() — using liveTranscript fallback")
            finalText = liveTranscript
        }

        guard !finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            print("[RecordingVM] stopRecording() — finalText is empty, discarding")
            liveTranscript = ""
            return
        }

        // Process the transcript through the pipeline
        print("[RecordingVM] stopRecording() — sending to pipeline: \"\(finalText.prefix(80))\"")
        do {
            try await pipeline.process(rawTranscript: finalText)
            liveTranscript = ""
            print("[RecordingVM] stopRecording() — pipeline complete")
        } catch {
            errorMessage = "Failed to save note: \(error.localizedDescription)"
            print("[RecordingVM] stopRecording() pipeline ERROR — \(error)")
        }
    }

    func updateSpeechService(_ service: SpeechServiceProtocol) {
        self.speechService = service
    }
}
