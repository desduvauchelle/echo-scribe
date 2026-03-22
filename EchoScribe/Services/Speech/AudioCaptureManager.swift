import AVFoundation

final class AudioCaptureManager {
    private let audioEngine = AVAudioEngine()
    private var audioLevelCallback: ((Float) -> Void)?
    private var audioBufferCallback: ((AVAudioPCMBuffer) -> Void)?

    var inputNode: AVAudioInputNode {
        audioEngine.inputNode
    }

    var inputFormat: AVAudioFormat {
        audioEngine.inputNode.outputFormat(forBus: 0)
    }

    func startCapture(
        audioLevelCallback: @escaping (Float) -> Void,
        audioBufferCallback: ((AVAudioPCMBuffer) -> Void)? = nil
    ) throws {
        self.audioLevelCallback = audioLevelCallback
        self.audioBufferCallback = audioBufferCallback

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.processAudioLevel(buffer: buffer)
            self?.audioBufferCallback?(buffer)
        }

        audioEngine.prepare()
        try audioEngine.start()
    }

    func stopCapture() {
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        audioLevelCallback = nil
        audioBufferCallback = nil
    }

    var isRunning: Bool {
        audioEngine.isRunning
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
