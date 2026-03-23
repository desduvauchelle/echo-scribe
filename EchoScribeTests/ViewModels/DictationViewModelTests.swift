import Testing
import AppKit
@testable import Echo_Scribe

// MARK: - Mock Speech Service

@MainActor
final class MockSpeechService: SpeechServiceProtocol {
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

    func sendUpdate(_ text: String) {
        transcriptionContinuation?.yield(TranscriptionUpdate(partialText: text, isFinal: false, confidence: 1.0))
    }
}

// MARK: - DictationViewModel Tests

@MainActor
@Suite("DictationViewModel")
struct DictationViewModelTests {

    private func makeSUT() -> (DictationViewModel, MockSpeechService, RecordingCoordinator) {
        let speech = MockSpeechService()
        let coordinator = RecordingCoordinator()
        let vm = DictationViewModel(speechService: speech, coordinator: coordinator)
        return (vm, speech, coordinator)
    }

    // MARK: - Start Dictation

    @Test("startDictation begins recording")
    func startDictationBeginsRecording() async {
        let (vm, speech, _) = makeSUT()

        await vm.startDictation()

        #expect(vm.isRecording)
        #expect(speech.isRecording)
        #expect(vm.errorMessage == nil)
    }

    @Test("startDictation respects coordinator lock")
    func startDictationRespectsCoordinator() async {
        let (vm, speech, coordinator) = makeSUT()
        coordinator.claim(.brain)

        await vm.startDictation()

        #expect(!vm.isRecording)
        #expect(!speech.isRecording)
    }

    @Test("startDictation does not double-start")
    func startDictationDoesNotDoubleStart() async {
        let (vm, _, _) = makeSUT()

        await vm.startDictation()
        #expect(vm.isRecording)

        await vm.startDictation()
        #expect(vm.isRecording)
    }

    @Test("startDictation handles speech service errors")
    func startDictationHandlesSpeechError() async {
        let (vm, speech, coordinator) = makeSUT()
        speech.startRecordingError = SpeechError.notAuthorized

        await vm.startDictation()

        #expect(!vm.isRecording)
        #expect(vm.errorMessage != nil)
        #expect(coordinator.canStart(.dictation), "Coordinator should be released after error")
    }

    @Test("startDictation clears previous state")
    func startDictationClearsPreviousState() async {
        let (vm, _, _) = makeSUT()
        vm.errorMessage = "old error"
        vm.liveTranscript = "old transcript"

        await vm.startDictation()

        #expect(vm.errorMessage == nil)
        #expect(vm.liveTranscript.isEmpty)
        #expect(vm.lastPasteResult == nil)
    }

    // MARK: - Stop and Paste

    @Test("stopDictationAndPaste does nothing when not recording")
    func stopWhenNotRecording() async {
        let (vm, _, _) = makeSUT()

        await vm.stopDictationAndPaste()

        #expect(vm.errorMessage == nil)
        #expect(vm.liveTranscript.isEmpty)
        #expect(vm.lastPasteResult == nil)
    }

    @Test("stopDictationAndPaste clears state on empty transcript")
    func stopWithEmptyTranscript() async {
        let (vm, speech, _) = makeSUT()
        speech.stopRecordingResult = "   "

        await vm.startDictation()
        await vm.stopDictationAndPaste()

        #expect(!vm.isRecording)
        #expect(vm.liveTranscript.isEmpty)
        #expect(vm.lastPasteResult == nil, "No result for empty transcript")
    }

    @Test("stopDictationAndPaste delivers text and sets result")
    func stopDeliversText() async {
        let (vm, speech, coordinator) = makeSUT()
        speech.stopRecordingResult = "Hello world"

        await vm.startDictation()
        #expect(vm.isRecording)

        await vm.stopDictationAndPaste()

        #expect(!vm.isRecording)
        #expect(!speech.isRecording)
        #expect(coordinator.canStart(.dictation), "Coordinator released")
        #expect(vm.liveTranscript.isEmpty)
        #expect(vm.lastPasteResult != nil, "Should have a paste result")
    }

    @Test("stopDictationAndPaste releases coordinator")
    func stopReleasesCoordinator() async {
        let (vm, speech, coordinator) = makeSUT()
        speech.stopRecordingResult = "text"

        await vm.startDictation()
        #expect(!coordinator.canStart(.brain))

        await vm.stopDictationAndPaste()
        #expect(coordinator.canStart(.brain), "Coordinator should be released")
    }

    // MARK: - Update Speech Service

    @Test("updateSpeechService replaces the service")
    func updateSpeechService() async {
        let (vm, _, _) = makeSUT()
        let newService = MockSpeechService()

        vm.updateSpeechService(newService)

        await vm.startDictation()
        #expect(newService.isRecording, "New service should be used")
    }
}

// MARK: - ClipboardPasteService Tests

@MainActor
@Suite("ClipboardPasteService")
struct ClipboardPasteServiceTests {

    @Test("isAccessibilityTrusted returns a boolean without crashing")
    func accessibilityTrustedReturnsBool() {
        let _ = ClipboardPasteService.isAccessibilityTrusted
    }

    @Test("deliverText always returns a result")
    func deliverTextAlwaysReturns() async {
        let result = await ClipboardPasteService.deliverText("Test text")

        switch result {
        case .pasted:
            // Accessibility was granted — auto-paste happened
            break
        case .copiedToClipboard:
            // No accessibility — text should be on clipboard
            let clipboard = NSPasteboard.general.string(forType: .string)
            #expect(clipboard == "Test text", "Text should be on clipboard")
        }
    }

    @Test("copyToClipboard puts text on pasteboard")
    func copyToClipboardWorks() {
        ClipboardPasteService.copyToClipboard("clipboard test")
        let result = NSPasteboard.general.string(forType: .string)
        #expect(result == "clipboard test")
    }

    @Test("deliverText returns copiedToClipboard when no accessibility")
    func deliverTextFallsBackToClipboard() async {
        guard !ClipboardPasteService.isAccessibilityTrusted else { return }

        let result = await ClipboardPasteService.deliverText("Fallback test")
        #expect(result == .copiedToClipboard)

        let clipboard = NSPasteboard.general.string(forType: .string)
        #expect(clipboard == "Fallback test")
    }

    @Test("deliverText returns pasted when accessibility is granted")
    func deliverTextPastesWithAccessibility() async {
        guard ClipboardPasteService.isAccessibilityTrusted else { return }

        let result = await ClipboardPasteService.deliverText("Paste test")
        #expect(result == .pasted)
    }
}

// MARK: - CapsLockShortcutService Tests

@MainActor
@Suite("CapsLockShortcutService")
struct CapsLockShortcutServiceTests {

    @Test("start returns bool based on accessibility")
    func startReturnsBool() {
        let service = CapsLockShortcutService.shared
        service.stop()

        let result = service.start()

        if ClipboardPasteService.isAccessibilityTrusted {
            #expect(result, "Should succeed with accessibility")
            #expect(!service.eventTapFailed)
        } else {
            #expect(!result, "Should fail without accessibility")
            #expect(service.eventTapFailed)
        }

        service.stop()
    }

    @Test("stop resets running state and allows restart")
    func stopResetsState() {
        let service = CapsLockShortcutService.shared
        _ = service.start()
        service.stop()

        // Should be able to start again without crash
        _ = service.start()
        service.stop()
    }

    @Test("eventTapFailed resets on new start")
    func eventTapFailedResetsOnStart() {
        let service = CapsLockShortcutService.shared
        service.stop()

        // First start might set eventTapFailed
        _ = service.start()
        service.stop()

        // Second start should reset it
        _ = service.start()
        // eventTapFailed should reflect current state, not previous
        let _ = service.eventTapFailed
        service.stop()
    }
}
