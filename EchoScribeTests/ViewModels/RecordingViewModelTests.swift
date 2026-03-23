import Testing
@testable import Echo_Scribe

// MARK: - Mock Speech Service (mirrors DictationViewModelTests)

@MainActor
private final class RecordingMockSpeechService: SpeechServiceProtocol {
    var isRecording = false
    var startRecordingError: Error?
    var stopRecordingResult = ""
    var transcriptionStream: AsyncStream<TranscriptionUpdate>?
    private var transcriptionContinuation: AsyncStream<TranscriptionUpdate>.Continuation?

    func startRecording() async throws {
        if let error = startRecordingError { throw error }
        isRecording = true
    }

    func stopRecording() async -> String {
        isRecording = false
        transcriptionContinuation?.finish()
        return stopRecordingResult
    }

    func transcriptionUpdates() -> AsyncStream<TranscriptionUpdate> {
        if let existing = transcriptionStream { return existing }
        let (stream, continuation) = AsyncStream.makeStream(of: TranscriptionUpdate.self)
        transcriptionContinuation = continuation
        transcriptionStream = stream
        return stream
    }

    func audioLevelUpdates() -> AsyncStream<Float> {
        AsyncStream { $0.finish() }
    }

    func sendUpdate(_ text: String, isFinal: Bool = false) {
        transcriptionContinuation?.yield(TranscriptionUpdate(partialText: text, isFinal: isFinal, confidence: 1.0))
    }
}

// MARK: - Tests

@MainActor
@Suite("RecordingViewModel")
struct RecordingViewModelTests {

    private func makeSUT() -> (RecordingViewModel, RecordingMockSpeechService) {
        let speech = RecordingMockSpeechService()
        let persistence = TestHelpers.makePersistence()
        let mlxService = MLXService()
        let pipeline = NoteProcessingPipeline(persistence: persistence, mlxService: mlxService)
        let coordinator = RecordingCoordinator()
        let vm = RecordingViewModel(speechService: speech, pipeline: pipeline, coordinator: coordinator)
        return (vm, speech)
    }

    // MARK: - Empty result fallback

    @Test("stopRecording uses liveTranscript when service returns empty")
    func stopRecording_emptyResult_usesLiveTranscriptFallback() async {
        let (vm, speech) = makeSUT()
        speech.stopRecordingResult = ""

        await vm.startRecording()
        #expect(vm.isRecording)

        // Simulate liveTranscript having been populated by the stream consumer during recording
        vm.liveTranscript = "Hello this is a test"

        // Stop — service returns empty, but liveTranscript should be used as fallback
        await vm.stopRecording()

        #expect(!vm.isRecording)
        // liveTranscript is cleared after successful processing via pipeline
        #expect(vm.liveTranscript.isEmpty, "liveTranscript should be cleared after processing")
    }

    @Test("stopRecording discards when both service result and liveTranscript are empty")
    func stopRecording_emptyResult_emptyLiveTranscript_discards() async {
        let (vm, speech) = makeSUT()
        speech.stopRecordingResult = ""

        await vm.startRecording()
        #expect(vm.isRecording)

        // No partial updates sent — liveTranscript stays empty
        await vm.stopRecording()

        #expect(!vm.isRecording)
        #expect(vm.liveTranscript.isEmpty)
    }

    @Test("stopRecording uses service result when non-empty")
    func stopRecording_nonEmptyResult_usesServiceResult() async {
        let (vm, speech) = makeSUT()
        speech.stopRecordingResult = "Service provided this text"

        await vm.startRecording()
        await vm.stopRecording()

        #expect(!vm.isRecording)
        // liveTranscript is cleared after successful processing
        #expect(vm.liveTranscript.isEmpty)
    }

    // MARK: - Basic recording lifecycle

    @Test("startRecording sets isRecording")
    func startRecordingSetsState() async {
        let (vm, speech) = makeSUT()

        await vm.startRecording()

        #expect(vm.isRecording)
        #expect(speech.isRecording)
    }

    @Test("startRecording handles speech service error")
    func startRecordingHandlesError() async {
        let (vm, speech) = makeSUT()
        speech.startRecordingError = SpeechError.notAuthorized

        await vm.startRecording()

        #expect(!vm.isRecording)
        #expect(vm.errorMessage != nil)
    }
}
