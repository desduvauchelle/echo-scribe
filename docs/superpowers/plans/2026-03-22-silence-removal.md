# Silence Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a silence removal (VAD) pass that strips silence from audio samples before transcription, reducing Whisper/Parakeet hallucinations during pauses.

**Architecture:** A standalone `SilenceRemover` utility processes `[Float]` audio samples by scanning for silence segments (below a configurable RMS threshold) longer than ~500ms and removing them. It is called in `WhisperSpeechService.transcribeAudio()` and `ParakeetSpeechService.transcribeAudio()` before handing samples to the model. A toggle in Settings persists via `@AppStorage`. Apple Speech is excluded — it handles VAD internally.

**Tech Stack:** Swift, Accelerate framework (vDSP for fast RMS), UserDefaults/@AppStorage

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `EchoScribe/Services/Speech/SilenceRemover.swift` | Create | Pure function: strips silence from `[Float]` audio samples |
| `EchoScribeTests/Services/SilenceRemoverTests.swift` | Create | Unit tests for silence removal logic |
| `EchoScribe/Utilities/Constants.swift` | Modify | Add `removeSilenceKey` constant |
| `EchoScribe/Services/Speech/WhisperSpeechService.swift` | Modify | Call `SilenceRemover` before transcription |
| `EchoScribe/Services/Speech/ParakeetSpeechService.swift` | Modify | Call `SilenceRemover` before transcription |
| `EchoScribe/Views/Settings/SettingsView.swift` | Modify | Add toggle in Voice tab |

---

### Task 1: SilenceRemover — Tests

**Files:**
- Create: `EchoScribeTests/Services/SilenceRemoverTests.swift`

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest
@testable import EchoScribe

final class SilenceRemoverTests: XCTestCase {

    // Helper: generate silence (zeros) for a given duration at a sample rate
    private func silence(seconds: Double, sampleRate: Double = 16000) -> [Float] {
        [Float](repeating: 0, count: Int(seconds * sampleRate))
    }

    // Helper: generate a sine tone for a given duration
    private func tone(seconds: Double, frequency: Float = 440, amplitude: Float = 0.5, sampleRate: Double = 16000) -> [Float] {
        let count = Int(seconds * sampleRate)
        return (0..<count).map { i in
            amplitude * sin(2 * .pi * frequency * Float(i) / Float(sampleRate))
        }
    }

    func testEmptyInputReturnsEmpty() {
        let result = SilenceRemover.removeSilence(from: [], sampleRate: 16000)
        XCTAssertTrue(result.isEmpty)
    }

    func testAllSilenceReturnsEmpty() {
        let input = silence(seconds: 3.0)
        let result = SilenceRemover.removeSilence(from: input, sampleRate: 16000)
        XCTAssertTrue(result.isEmpty)
    }

    func testPureToneUnchanged() {
        let input = tone(seconds: 1.0)
        let result = SilenceRemover.removeSilence(from: input, sampleRate: 16000)
        // Should keep all samples (tone is above threshold)
        XCTAssertEqual(result.count, input.count)
    }

    func testRemovesSilenceGapBetweenSpeech() {
        // speech (0.5s) + silence (1s) + speech (0.5s)
        let speech1 = tone(seconds: 0.5)
        let gap = silence(seconds: 1.0)
        let speech2 = tone(seconds: 0.5)
        let input = speech1 + gap + speech2

        let result = SilenceRemover.removeSilence(from: input, sampleRate: 16000)
        // The 1s silence gap should be removed; result should be roughly speech1 + speech2
        XCTAssertLessThan(result.count, input.count)
        // Should be close to speech1.count + speech2.count (with some margin for window edges)
        XCTAssertGreaterThan(result.count, speech1.count + speech2.count - 1000)
    }

    func testKeepsShortPauses() {
        // speech (0.5s) + short pause (0.2s, below 500ms threshold) + speech (0.5s)
        let speech1 = tone(seconds: 0.5)
        let shortPause = silence(seconds: 0.2)
        let speech2 = tone(seconds: 0.5)
        let input = speech1 + shortPause + speech2

        let result = SilenceRemover.removeSilence(from: input, sampleRate: 16000)
        // Short pause should be kept — result should equal input
        XCTAssertEqual(result.count, input.count)
    }

    func testRemovesLeadingAndTrailingSilence() {
        let leading = silence(seconds: 2.0)
        let speech = tone(seconds: 1.0)
        let trailing = silence(seconds: 2.0)
        let input = leading + speech + trailing

        let result = SilenceRemover.removeSilence(from: input, sampleRate: 16000)
        // Should strip 2s leading + 2s trailing silence
        XCTAssertLessThan(result.count, input.count)
        // Result should be roughly the speech portion
        let speechCount = speech.count
        XCTAssertGreaterThan(result.count, speechCount - 1000)
        XCTAssertLessThan(result.count, speechCount + 2000)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `xcodebuild test -project EchoScribe.xcodeproj -scheme EchoScribe -only-testing:EchoScribeTests/SilenceRemoverTests 2>&1 | tail -20`
Expected: FAIL — `SilenceRemover` not found

---

### Task 2: SilenceRemover — Implementation

**Files:**
- Create: `EchoScribe/Services/Speech/SilenceRemover.swift`

- [ ] **Step 1: Implement SilenceRemover**

```swift
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

        // Compute RMS for each window and classify as voice/silence
        var isVoiced = [Bool](repeating: false, count: samples.count)

        var windowStart = 0
        while windowStart < samples.count {
            let windowEnd = min(windowStart + windowSamples, samples.count)
            let count = windowEnd - windowStart

            // Use vDSP for fast RMS
            var rms: Float = 0
            samples.withUnsafeBufferPointer { buffer in
                let ptr = buffer.baseAddress! + windowStart
                var sumSquares: Float = 0
                vDSP_svesq(ptr, 1, &sumSquares, vDSP_Length(count))
                rms = sqrtf(sumSquares / Float(count))
            }

            if rms >= threshold {
                for i in windowStart..<windowEnd {
                    isVoiced[i] = true
                }
            }

            windowStart += windowSamples
        }

        // Find silence runs and remove those longer than minSilenceDuration
        var result = [Float]()
        result.reserveCapacity(samples.count)

        var i = 0
        while i < samples.count {
            if isVoiced[i] {
                result.append(samples[i])
                i += 1
            } else {
                // Count consecutive silent samples
                let silenceStart = i
                while i < samples.count && !isVoiced[i] {
                    i += 1
                }
                let silenceLength = i - silenceStart

                if silenceLength < minSilenceSamples {
                    // Keep short pauses
                    result.append(contentsOf: samples[silenceStart..<i])
                }
                // Long silence: skip (don't append)
            }
        }

        return result
    }
}
```

- [ ] **Step 2: Add file to Xcode project**

Add `SilenceRemover.swift` to the EchoScribe target in the project, alongside other files in `Services/Speech/`.

- [ ] **Step 3: Run tests to verify they pass**

Run: `xcodebuild test -project EchoScribe.xcodeproj -scheme EchoScribe -only-testing:EchoScribeTests/SilenceRemoverTests 2>&1 | tail -20`
Expected: All 6 tests PASS

- [ ] **Step 4: Commit**

```bash
git add EchoScribe/Services/Speech/SilenceRemover.swift EchoScribeTests/Services/SilenceRemoverTests.swift
git commit -m "feat: add SilenceRemover to strip silence from audio before transcription"
```

---

### Task 3: Settings Constant & Toggle

**Files:**
- Modify: `EchoScribe/Utilities/Constants.swift`
- Modify: `EchoScribe/Views/Settings/SettingsView.swift`

- [ ] **Step 1: Add constant**

In `Constants.swift`, add inside the `Constants` enum:

```swift
static let removeSilenceKey = "removeSilence"
```

- [ ] **Step 2: Register the default value**

In `EchoScribeApp.swift`, add at the very top of `init()` (before any service setup):

```swift
UserDefaults.standard.register(defaults: [
    Constants.removeSilenceKey: true
])
```

This ensures `UserDefaults.standard.bool(forKey:)` returns `true` when the user hasn't explicitly set a value, matching the `@AppStorage` default.

- [ ] **Step 3: Add @AppStorage toggle in SettingsView**

In `SettingsView.swift`, add a new `@AppStorage` property alongside the existing ones (near line 39):

```swift
// Key must match Constants.removeSilenceKey
@AppStorage("removeSilence") private var removeSilence = true
```

Note: defaults to `true` — silence removal is on by default since it improves quality.

- [ ] **Step 4: Add UI section in the Voice tab**

Add a new section in the Voice tab. In the `case .voice:` switch branch (around line 78-79), add `silenceRemovalSection` after `voiceToTextSection` and before `aiImprovementsSection`:

```swift
case .voice:
    microphoneSection
    voiceToTextSection
    silenceRemovalSection
    aiImprovementsSection
```

Then add the computed property:

```swift
// MARK: - Silence Removal

private var silenceRemovalSection: some View {
    VStack(alignment: .leading, spacing: Spacing.sm) {
        Text("AUDIO PROCESSING")
            .sectionLabel()

        VStack(spacing: Spacing.md) {
            Toggle("Remove silence", isOn: $removeSilence)
                .foregroundStyle(.secondary)

            Text("Strips long pauses from audio before transcription. Reduces hallucinated text during silence. Only affects Whisper and Parakeet engines.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: Radius.md)
                .fill(AppColors.surface)
        )
        .modifier(Elevation.card(colorScheme))
    }
}
```

- [ ] **Step 5: Commit**

```bash
git add EchoScribe/Utilities/Constants.swift EchoScribe/Views/Settings/SettingsView.swift EchoScribe/App/EchoScribeApp.swift
git commit -m "feat: add silence removal toggle in Voice settings"
```

---

### Task 4: Integrate into WhisperSpeechService

**Files:**
- Modify: `EchoScribe/Services/Speech/WhisperSpeechService.swift`

- [ ] **Step 1: Add silence removal to `transcribeAudio()`**

In `WhisperSpeechService.swift`, modify the `transcribeAudio(_:)` method (around line 363). Add silence removal before calling `whisperKit.transcribe()`:

```swift
nonisolated private func transcribeAudio(_ audioArray: [Float]) async -> String? {
    print("[WhisperService] transcribeAudio() — sampleCount=\(audioArray.count)")

    // Apply silence removal if enabled
    let samplesToTranscribe: [Float]
    let removeSilence = UserDefaults.standard.bool(forKey: Constants.removeSilenceKey)
    if removeSilence {
        let sampleRate = await MainActor.run {
            self.audioCaptureManager.inputFormat?.sampleRate ?? 16000
        }
        samplesToTranscribe = SilenceRemover.removeSilence(from: audioArray, sampleRate: sampleRate)
        print("[WhisperService] silence removal: \(audioArray.count) → \(samplesToTranscribe.count) samples")
        guard !samplesToTranscribe.isEmpty else {
            print("[WhisperService] all silence removed, skipping transcription")
            return nil
        }
    } else {
        samplesToTranscribe = audioArray
    }

    do {
        let results = try await MainActor.run { self.whisperKit }?.transcribe(audioArray: samplesToTranscribe)
        let text = results?.first?.text.trimmingCharacters(in: .whitespacesAndNewlines)
        print("[WhisperService] transcribeAudio() — result: \(text.map { "\"\($0.prefix(80))\"" } ?? "nil")")
        return text
    } catch {
        print("[WhisperService] transcribeAudio() ERROR — \(error)")
        return nil
    }
}
```

Note: We read `UserDefaults` directly because this method is `nonisolated` and can't access `@AppStorage`. The `removeSilenceKey` defaults to `false` in `UserDefaults.standard.bool()`, but we register the default as `true` — see Task 5.

- [ ] **Step 2: Commit**

```bash
git add EchoScribe/Services/Speech/WhisperSpeechService.swift
git commit -m "feat: integrate silence removal into WhisperSpeechService"
```

---

### Task 5: Integrate into ParakeetSpeechService

**Files:**
- Modify: `EchoScribe/Services/Speech/ParakeetSpeechService.swift`

- [ ] **Step 1: Add silence removal to `transcribeAudio()`**

In `ParakeetSpeechService.swift`, modify the `transcribeAudio(_:)` method (around line 234). Add silence removal before resampling and transcription:

```swift
nonisolated private func transcribeAudio(_ audioArray: [Float]) async -> String? {
    do {
        let manager = await MainActor.run { self.asrManager }
        guard let manager else { return nil }

        let sampleRate = await MainActor.run {
            self.audioCaptureManager.inputFormat?.sampleRate ?? 16000
        }

        // Apply silence removal if enabled
        var processedAudio = audioArray
        let removeSilence = UserDefaults.standard.bool(forKey: Constants.removeSilenceKey)
        if removeSilence {
            processedAudio = SilenceRemover.removeSilence(from: audioArray, sampleRate: sampleRate)
            print("[ParakeetService] silence removal: \(audioArray.count) → \(processedAudio.count) samples")
            guard !processedAudio.isEmpty else {
                print("[ParakeetService] all silence removed, skipping transcription")
                return nil
            }
        }

        // Parakeet expects 16kHz mono audio — resample if needed
        let samples: [Float]
        if sampleRate != 16000 {
            samples = resampleAudio(processedAudio, fromRate: sampleRate, toRate: 16000)
        } else {
            samples = processedAudio
        }

        let result = try await manager.transcribe(samples)
        return result.text.trimmingCharacters(in: .whitespacesAndNewlines)
    } catch {
        print("[ParakeetService] transcribeAudio() ERROR — \(error)")
        return nil
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add EchoScribe/Services/Speech/ParakeetSpeechService.swift
git commit -m "feat: integrate silence removal into ParakeetSpeechService"
```

---

### Task 6: Build & Verify

- [ ] **Step 1: Build the full project**

Run: `xcodebuild build -project EchoScribe.xcodeproj -scheme EchoScribe 2>&1 | tail -20`
Expected: BUILD SUCCEEDED

- [ ] **Step 2: Run all tests**

Run: `xcodebuild test -project EchoScribe.xcodeproj -scheme EchoScribe 2>&1 | tail -30`
Expected: All tests pass

- [ ] **Step 3: Commit if any fixes were needed**
