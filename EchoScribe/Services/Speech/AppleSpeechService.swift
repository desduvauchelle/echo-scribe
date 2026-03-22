import Foundation
@preconcurrency import Speech
import AVFoundation

@MainActor
final class AppleSpeechService: SpeechServiceProtocol {
    private let speechRecognizer: SFSpeechRecognizer
    private let audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var continuation: AsyncStream<TranscriptionUpdate>.Continuation?
    private var audioLevelContinuation: AsyncStream<Float>.Continuation?
    private var finalTranscript = ""
    private var lastPartialText = ""
    private var accumulatedTranscript = ""
    private var isStoppingManually = false

    private(set) var isRecording = false
    var audioDeviceManager: AudioDeviceManager?

    init(locale: Locale = .current) {
        self.speechRecognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
    }

    func startRecording() async throws {
        guard !isRecording else { return }

        // Request authorization
        let authStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { @Sendable status in
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
        lastPartialText = ""
        accumulatedTranscript = ""
        isStoppingManually = false

        try startRecognitionSession()
    }

    /// Starts (or restarts) the speech recognition task on the running audio engine.
    private func startRecognitionSession() throws {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        self.recognitionRequest = request

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        let levelContinuation = audioLevelContinuation
        let tapHandler: @Sendable (AVAudioPCMBuffer, AVAudioTime) -> Void = { buffer, _ in
            request.append(buffer)
            // Calculate audio level for waveform
            guard let channelData = buffer.floatChannelData?[0] else { return }
            let frames = buffer.frameLength
            var sum: Float = 0
            for i in 0..<Int(frames) {
                sum += channelData[i] * channelData[i]
            }
            let rms = sqrtf(sum / Float(frames))
            let db = 20 * log10f(max(rms, 0.000001))
            let normalizedLevel = max(0, min(1, (db + 50) / 50))
            levelContinuation?.yield(normalizedLevel)
        }

        if !audioEngine.isRunning {
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat, block: tapHandler)
            audioDeviceManager?.applyDevice(to: audioEngine)
            audioEngine.prepare()
            try audioEngine.start()
        } else {
            // Reinstall tap for the new request
            inputNode.removeTap(onBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat, block: tapHandler)
        }

        isRecording = true

        recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor [weak self] in
                guard let self else { return }

                if let result {
                    let text = result.bestTranscription.formattedString
                    let isFinal = result.isFinal
                    let confidence: Float = result.bestTranscription.segments.last?.confidence ?? 0

                    self.lastPartialText = text

                    if isFinal {
                        self.finalTranscript = text
                    }

                    // Prepend accumulated text from previous recognition sessions
                    let fullText = self.accumulatedTranscript.isEmpty
                        ? text
                        : self.accumulatedTranscript + " " + text

                    self.continuation?.yield(TranscriptionUpdate(
                        partialText: fullText,
                        isFinal: isFinal,
                        confidence: confidence
                    ))
                }

                if error != nil && !self.isStoppingManually {
                    // Recognition timed out or errored — accumulate and restart
                    let currentText = self.lastPartialText
                    if !currentText.isEmpty {
                        self.accumulatedTranscript = self.accumulatedTranscript.isEmpty
                            ? currentText
                            : self.accumulatedTranscript + " " + currentText
                    }
                    self.lastPartialText = ""
                    self.finalTranscript = ""
                    self.recognitionRequest = nil
                    self.recognitionTask = nil

                    // Restart recognition to keep listening
                    do {
                        try self.startRecognitionSession()
                    } catch {
                        // If restart fails, yield what we have
                        self.continuation?.yield(TranscriptionUpdate(
                            partialText: self.accumulatedTranscript,
                            isFinal: true,
                            confidence: 0
                        ))
                    }
                }
            }
        }
    }

    func stopRecording() async -> String {
        isStoppingManually = true

        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
        isRecording = false

        continuation?.finish()
        continuation = nil
        audioLevelContinuation?.finish()
        audioLevelContinuation = nil

        // Return the best available text: accumulated + current session
        let currentSessionText = !finalTranscript.isEmpty ? finalTranscript : lastPartialText
        let result: String
        if accumulatedTranscript.isEmpty {
            result = currentSessionText
        } else if currentSessionText.isEmpty {
            result = accumulatedTranscript
        } else {
            result = accumulatedTranscript + " " + currentSessionText
        }
        return result
    }

    func transcriptionUpdates() -> AsyncStream<TranscriptionUpdate> {
        AsyncStream { continuation in
            self.continuation = continuation
        }
    }

    func audioLevelUpdates() -> AsyncStream<Float> {
        AsyncStream { continuation in
            self.audioLevelContinuation = continuation
        }
    }
}

