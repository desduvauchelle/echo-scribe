import Foundation
import Speech
import AVFoundation

@MainActor
final class AppleSpeechService: SpeechServiceProtocol {
    private let speechRecognizer: SFSpeechRecognizer
    private let audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var continuation: AsyncStream<TranscriptionUpdate>.Continuation?
    private var finalTranscript = ""

    private(set) var isRecording = false

    init(locale: Locale = .current) {
        self.speechRecognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
    }

    func startRecording() async throws {
        guard !isRecording else { return }

        // Request authorization
        let authStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }

        guard authStatus == .authorized else {
            throw SpeechError.notAuthorized
        }

        guard speechRecognizer.isAvailable else {
            throw SpeechError.recognizerUnavailable
        }

        finalTranscript = ""

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        self.recognitionRequest = request

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            request.append(buffer)
        }

        audioEngine.prepare()
        try audioEngine.start()
        isRecording = true

        recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }

            if let result {
                let text = result.bestTranscription.formattedString
                let isFinal = result.isFinal
                let confidence: Float = result.bestTranscription.segments.last?.confidence ?? 0

                if isFinal {
                    self.finalTranscript = text
                }

                self.continuation?.yield(TranscriptionUpdate(
                    partialText: text,
                    isFinal: isFinal,
                    confidence: confidence
                ))
            }

            if error != nil {
                self.continuation?.yield(TranscriptionUpdate(
                    partialText: self.finalTranscript,
                    isFinal: true,
                    confidence: 0
                ))
            }
        }
    }

    func stopRecording() async -> String {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
        isRecording = false

        continuation?.finish()
        continuation = nil

        return finalTranscript
    }

    func transcriptionUpdates() -> AsyncStream<TranscriptionUpdate> {
        AsyncStream { continuation in
            self.continuation = continuation
        }
    }
}

