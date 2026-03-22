import Foundation
@preconcurrency import Speech
import AVFoundation

/// Thread-safe counter for tap callback logging
private final class TapCounter: @unchecked Sendable {
    private var _count = 0
    private let lock = NSLock()
    func increment() -> Int {
        lock.withLock {
            _count += 1
            return _count
        }
    }
}

@MainActor
final class AppleSpeechService: SpeechServiceProtocol {
    private let speechRecognizer: SFSpeechRecognizer
    // Use a fresh engine each recording session to avoid stale format cache
    private var audioEngine: AVAudioEngine?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var continuation: AsyncStream<TranscriptionUpdate>.Continuation?
    private var audioLevelContinuation: AsyncStream<Float>.Continuation?
    private var finalTranscript = ""
    private var lastPartialText = ""
    private var accumulatedTranscript = ""
    private var isStoppingManually = false
    private var tapInstalled = false

    private(set) var isRecording = false
    var audioDeviceManager: AudioDeviceManager?

    init(locale: Locale = .current) {
        self.speechRecognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
    }

    func startRecording() async throws {
        print("[AppleSpeech] startRecording() called — isRecording=\(isRecording)")
        guard !isRecording else {
            print("[AppleSpeech] startRecording() — already recording, returning")
            return
        }

        // Request authorization
        let authStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { @Sendable status in
                continuation.resume(returning: status)
            }
        }
        print("[AppleSpeech] startRecording() — speech auth status: \(authStatus.rawValue) (authorized=\(authStatus == .authorized))")

        guard authStatus == .authorized else {
            throw SpeechError.notAuthorized
        }

        guard speechRecognizer.isAvailable else {
            print("[AppleSpeech] startRecording() — recognizer NOT available")
            throw SpeechError.recognizerUnavailable
        }

        finalTranscript = ""
        lastPartialText = ""
        accumulatedTranscript = ""
        isStoppingManually = false

        try startRecognitionSession(isRestart: false)
    }

    /// Starts (or restarts) the speech recognition task.
    /// On first start, creates a fresh AVAudioEngine to avoid stale format issues.
    /// On restart (recognition timeout), reuses the running engine.
    private func startRecognitionSession(isRestart: Bool) throws {
        print("[AppleSpeech] startRecognitionSession() — isRestart=\(isRestart)")

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        self.recognitionRequest = request

        let levelContinuation = audioLevelContinuation
        let tapCounter = TapCounter()
        let tapHandler: @Sendable (AVAudioPCMBuffer, AVAudioTime) -> Void = { buffer, _ in
            request.append(buffer)
            let count = tapCounter.increment()
            if count <= 3 || count % 100 == 0 {
                print("[AppleSpeech] tap callback #\(count) — frames=\(buffer.frameLength), format=\(buffer.format.sampleRate)Hz/\(buffer.format.channelCount)ch")
            }
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

        if !isRestart {
            // FRESH engine to guarantee no stale format cache
            tearDownAudioEngine()
            let engine = AVAudioEngine()
            self.audioEngine = engine

            let inputNode = engine.inputNode
            print("[AppleSpeech] created fresh AVAudioEngine")

            // Apply device and get the REAL hardware format from CoreAudio
            // inputNode.outputFormat is unreliable — it returns cached/default format
            var recordingFormat: AVAudioFormat
            if let deviceManager = audioDeviceManager {
                if let hwFormat = deviceManager.applyDevice(to: engine) {
                    recordingFormat = hwFormat
                    print("[AppleSpeech] using hardware format from CoreAudio: \(hwFormat.sampleRate)Hz/\(hwFormat.channelCount)ch")
                } else {
                    // Fallback to outputFormat if CoreAudio query fails
                    recordingFormat = inputNode.outputFormat(forBus: 0)
                    print("[AppleSpeech] WARNING — CoreAudio format query failed, falling back to outputFormat: \(recordingFormat.sampleRate)Hz/\(recordingFormat.channelCount)ch")
                }
            } else {
                // No device manager — get default device format from CoreAudio
                if let defaultFormat = AudioDeviceManager.getDefaultInputFormat() {
                    recordingFormat = defaultFormat
                    print("[AppleSpeech] using default device hardware format: \(defaultFormat.sampleRate)Hz/\(defaultFormat.channelCount)ch")
                } else {
                    recordingFormat = inputNode.outputFormat(forBus: 0)
                    print("[AppleSpeech] WARNING — falling back to outputFormat: \(recordingFormat.sampleRate)Hz/\(recordingFormat.channelCount)ch")
                }
            }

            guard recordingFormat.sampleRate > 0 && recordingFormat.channelCount > 0 else {
                print("[AppleSpeech] ERROR — invalid format, cannot start")
                throw NSError(domain: "AppleSpeechService", code: -1,
                              userInfo: [NSLocalizedDescriptionKey: "Invalid audio format (sampleRate=\(recordingFormat.sampleRate), channels=\(recordingFormat.channelCount))"])
            }

            inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat, block: tapHandler)
            tapInstalled = true
            print("[AppleSpeech] tap installed with format: \(recordingFormat.sampleRate)Hz/\(recordingFormat.channelCount)ch")

            engine.prepare()
            print("[AppleSpeech] engine prepared, attempting start...")

            do {
                try engine.start()
                print("[AppleSpeech] engine started successfully, isRunning=\(engine.isRunning)")
            } catch {
                print("[AppleSpeech] engine.start() FAILED — \(error)")
                inputNode.removeTap(onBus: 0)
                tapInstalled = false
                self.audioEngine = nil
                throw error
            }
        } else {
            // Restart case — engine is running, just reinstall tap for the new request
            guard let engine = audioEngine else {
                print("[AppleSpeech] restart but no engine — cannot continue")
                return
            }
            let inputNode = engine.inputNode
            if tapInstalled {
                inputNode.removeTap(onBus: 0)
                tapInstalled = false
            }
            let recordingFormat = inputNode.outputFormat(forBus: 0)
            print("[AppleSpeech] restart — reinstalling tap with format: \(recordingFormat.sampleRate)Hz/\(recordingFormat.channelCount)ch")
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat, block: tapHandler)
            tapInstalled = true
        }

        isRecording = true

        print("[AppleSpeech] starting recognition task...")
        recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor [weak self] in
                guard let self else { return }

                if let result {
                    let text = result.bestTranscription.formattedString
                    let isFinal = result.isFinal
                    let confidence: Float = result.bestTranscription.segments.last?.confidence ?? 0

                    print("[AppleSpeech] recognition result — isFinal=\(isFinal), confidence=\(confidence), text=\"\(text.prefix(80))\"")

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

                if let error, !self.isStoppingManually {
                    print("[AppleSpeech] recognition error (will restart) — \(error.localizedDescription)")
                    // Recognition timed out or errored — accumulate and restart
                    let currentText = self.lastPartialText
                    if !currentText.isEmpty {
                        self.accumulatedTranscript = self.accumulatedTranscript.isEmpty
                            ? currentText
                            : self.accumulatedTranscript + " " + currentText
                        print("[AppleSpeech] accumulated transcript so far: \"\(self.accumulatedTranscript.prefix(80))\"")
                    }
                    self.lastPartialText = ""
                    self.finalTranscript = ""
                    self.recognitionRequest = nil
                    self.recognitionTask = nil

                    // Restart recognition to keep listening
                    do {
                        try self.startRecognitionSession(isRestart: true)
                    } catch {
                        print("[AppleSpeech] restart failed — \(error)")
                        self.continuation?.yield(TranscriptionUpdate(
                            partialText: self.accumulatedTranscript,
                            isFinal: true,
                            confidence: 0
                        ))
                    }
                }
            }
        }
        print("[AppleSpeech] recognition task created")
    }

    func stopRecording() async -> String {
        print("[AppleSpeech] stopRecording() called — isRecording=\(isRecording)")
        isStoppingManually = true

        // Signal end of audio — this lets the recognizer produce a final result
        recognitionRequest?.endAudio()
        print("[AppleSpeech] stopRecording() — endAudio() called, waiting for final result...")

        // Give the recognizer a moment to produce a final result before we tear down
        try? await Task.sleep(for: .milliseconds(500))

        // Now tear down
        tearDownAudioEngine()
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
        print("[AppleSpeech] stopRecording() — finalTranscript=\"\(finalTranscript.prefix(60))\", lastPartial=\"\(lastPartialText.prefix(60))\"")
        print("[AppleSpeech] stopRecording() — accumulated=\"\(accumulatedTranscript.prefix(60))\"")
        print("[AppleSpeech] stopRecording() — returning text length=\(result.count): \"\(result.prefix(80))\"")
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

    // MARK: - Private Helpers

    private func tearDownAudioEngine() {
        guard let engine = audioEngine else { return }
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        if engine.isRunning {
            engine.stop()
        }
        audioEngine = nil
        print("[AppleSpeech] audio engine torn down")
    }
}
