import AVFoundation

/// Thread-safe counter for tap callback logging
private final class CaptureCounter: @unchecked Sendable {
    private var _count = 0
    private let lock = NSLock()
    func increment() -> Int {
        lock.withLock {
            _count += 1
            return _count
        }
    }
}

final class AudioCaptureManager {
    // Recreated each session to avoid stale format cache
    private var audioEngine: AVAudioEngine?
    private var audioLevelCallback: ((Float) -> Void)?
    private var audioBufferCallback: (([Float]) -> Void)?
    private var tapInstalled = false
    var audioDeviceManager: AudioDeviceManager?

    var inputNode: AVAudioInputNode? {
        audioEngine?.inputNode
    }

    var inputFormat: AVAudioFormat? {
        audioEngine?.inputNode.outputFormat(forBus: 0)
    }

    func startCapture(
        audioLevelCallback: @escaping (Float) -> Void,
        audioBufferCallback: (([Float]) -> Void)? = nil
    ) throws {
        print("[AudioCapture] startCapture() — setting up fresh AVAudioEngine")
        self.audioLevelCallback = audioLevelCallback
        self.audioBufferCallback = audioBufferCallback

        // Tear down any previous engine to start completely fresh
        stopCapture()

        let engine = AVAudioEngine()
        self.audioEngine = engine
        let inputNode = engine.inputNode

        // Apply device and get the REAL hardware format from CoreAudio
        // inputNode.outputFormat is unreliable — returns cached/default format
        var format: AVAudioFormat
        if let deviceManager = audioDeviceManager {
            if let hwFormat = deviceManager.applyDevice(to: engine) {
                format = hwFormat
                print("[AudioCapture] using hardware format from CoreAudio: \(hwFormat.sampleRate)Hz/\(hwFormat.channelCount)ch")
            } else {
                format = inputNode.outputFormat(forBus: 0)
                print("[AudioCapture] WARNING — CoreAudio format query failed, falling back to outputFormat: \(format.sampleRate)Hz/\(format.channelCount)ch")
            }
        } else {
            if let defaultFormat = AudioDeviceManager.getDefaultInputFormat() {
                format = defaultFormat
                print("[AudioCapture] using default device hardware format: \(defaultFormat.sampleRate)Hz/\(defaultFormat.channelCount)ch")
            } else {
                format = inputNode.outputFormat(forBus: 0)
                print("[AudioCapture] WARNING — falling back to outputFormat: \(format.sampleRate)Hz/\(format.channelCount)ch")
            }
        }

        // Validate format
        guard format.sampleRate > 0 && format.channelCount > 0 else {
            print("[AudioCapture] ERROR — invalid format, cannot start")
            self.audioEngine = nil
            throw NSError(domain: "AudioCaptureManager", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "Invalid audio input format (sampleRate=\(format.sampleRate), channels=\(format.channelCount))"])
        }

        let tapCounter = CaptureCounter()
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            let count = tapCounter.increment()
            if count <= 3 || count % 200 == 0 {
                print("[AudioCapture] tap callback #\(count) — frames=\(buffer.frameLength)")
            }
            self?.processAudioLevel(buffer: buffer)

            // Copy float samples immediately while buffer memory is valid
            if let callback = self?.audioBufferCallback,
               let channelData = buffer.floatChannelData?[0] {
                let frameCount = Int(buffer.frameLength)
                let samples = Array(UnsafeBufferPointer(start: channelData, count: frameCount))
                callback(samples)
            }
        }
        tapInstalled = true
        print("[AudioCapture] tap installed")

        engine.prepare()
        print("[AudioCapture] engine prepared, attempting start...")

        do {
            try engine.start()
            print("[AudioCapture] engine started successfully, isRunning=\(engine.isRunning)")
        } catch {
            print("[AudioCapture] engine.start() FAILED — \(error)")
            inputNode.removeTap(onBus: 0)
            tapInstalled = false
            self.audioEngine = nil
            self.audioLevelCallback = nil
            self.audioBufferCallback = nil
            throw error
        }
    }

    func stopCapture() {
        guard let engine = audioEngine else { return }
        print("[AudioCapture] stopCapture() — tearing down engine")
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        if engine.isRunning {
            engine.stop()
        }
        audioEngine = nil
        audioLevelCallback = nil
        audioBufferCallback = nil
        print("[AudioCapture] stopCapture() — done")
    }

    var isRunning: Bool {
        audioEngine?.isRunning ?? false
    }

    private func processAudioLevel(buffer: AVAudioPCMBuffer) {
        guard let channelData = buffer.floatChannelData?[0] else { return }
        let frames = buffer.frameLength

        var sum: Float = 0
        for i in 0..<Int(frames) {
            sum += channelData[i] * channelData[i]
        }
        let rms = sqrtf(sum / Float(frames))
        let db = 20 * log10f(max(rms, 0.000001))
        let normalizedLevel = max(0, min(1, (db + 50) / 50))

        audioLevelCallback?(normalizedLevel)
    }
}
