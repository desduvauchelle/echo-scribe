import Accelerate

enum SilenceRemover {
    /// Removes silence segments longer than `minSilenceDuration` from audio samples.
    /// - Parameters:
    ///   - samples: Raw audio as `[Float]`
    ///   - sampleRate: Sample rate in Hz (e.g. 16000)
    ///   - minSilenceDuration: Minimum silence duration (seconds) to strip. Default 0.5s.
    ///   - threshold: RMS threshold below which audio is considered silence. Default 0.01.
    ///   - windowSize: Analysis window in seconds. Default 0.03s (30ms).
    /// - Returns: Audio samples with long silence segments removed.
    static func removeSilence(
        from samples: [Float],
        sampleRate: Double,
        minSilenceDuration: Double = 0.5,
        threshold: Float = 0.01,
        windowSize: Double = 0.03
    ) -> [Float] {
        guard !samples.isEmpty else { return [] }

        let windowSamples = max(1, Int(windowSize * sampleRate))
        let minSilenceSamples = Int(minSilenceDuration * sampleRate)
        let windowCount = (samples.count + windowSamples - 1) / windowSamples

        // Classify each window as voiced/silent — one Bool per window, not per sample
        var windowVoiced = [Bool](repeating: false, count: windowCount)

        samples.withUnsafeBufferPointer { buffer in
            for w in 0..<windowCount {
                let start = w * windowSamples
                let count = min(windowSamples, samples.count - start)
                let ptr = buffer.baseAddress! + start
                var sumSquares: Float = 0
                vDSP_svesq(ptr, 1, &sumSquares, vDSP_Length(count))
                let rms = sqrtf(sumSquares / Float(count))
                windowVoiced[w] = rms >= threshold
            }
        }

        // Walk windows, tracking silence runs and copying voiced regions
        var result = [Float]()
        result.reserveCapacity(samples.count)

        var w = 0
        while w < windowCount {
            if windowVoiced[w] {
                let start = w * windowSamples
                let end = min(start + windowSamples, samples.count)
                result.append(contentsOf: samples[start..<end])
                w += 1
            } else {
                // Count consecutive silent windows
                let silenceStartWindow = w
                while w < windowCount && !windowVoiced[w] {
                    w += 1
                }
                let silenceStartSample = silenceStartWindow * windowSamples
                let silenceEndSample = min(w * windowSamples, samples.count)
                let silenceLength = silenceEndSample - silenceStartSample

                // Keep short silences (pauses between words)
                if silenceLength < minSilenceSamples {
                    result.append(contentsOf: samples[silenceStartSample..<silenceEndSample])
                }
            }
        }

        return result
    }
}
