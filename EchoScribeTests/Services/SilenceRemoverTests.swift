import XCTest
@testable import Echo_Scribe

final class SilenceRemoverTests: XCTestCase {

    // MARK: - Helpers

    private func silence(seconds: Double, sampleRate: Double = 16000) -> [Float] {
        [Float](repeating: 0, count: Int(seconds * sampleRate))
    }

    private func tone(seconds: Double, frequency: Float = 440, amplitude: Float = 0.5, sampleRate: Double = 16000) -> [Float] {
        let count = Int(seconds * sampleRate)
        return (0..<count).map { i in
            amplitude * sin(2 * .pi * frequency * Float(i) / Float(sampleRate))
        }
    }

    // MARK: - Tests

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
        XCTAssertEqual(result.count, input.count)
    }

    func testRemovesSilenceGapBetweenSpeech() {
        let speech1 = tone(seconds: 0.5)
        let gap = silence(seconds: 1.0)
        let speech2 = tone(seconds: 0.5)
        let input = speech1 + gap + speech2

        let result = SilenceRemover.removeSilence(from: input, sampleRate: 16000)
        XCTAssertLessThan(result.count, input.count)
        XCTAssertGreaterThan(result.count, speech1.count + speech2.count - 1000)
    }

    func testKeepsShortPauses() {
        let speech1 = tone(seconds: 0.5)
        let shortPause = silence(seconds: 0.2)
        let speech2 = tone(seconds: 0.5)
        let input = speech1 + shortPause + speech2

        let result = SilenceRemover.removeSilence(from: input, sampleRate: 16000)
        XCTAssertEqual(result.count, input.count)
    }

    func testRemovesLeadingAndTrailingSilence() {
        let leading = silence(seconds: 2.0)
        let speech = tone(seconds: 1.0)
        let trailing = silence(seconds: 2.0)
        let input = leading + speech + trailing

        let result = SilenceRemover.removeSilence(from: input, sampleRate: 16000)
        XCTAssertLessThan(result.count, input.count)
        let speechCount = speech.count
        XCTAssertGreaterThan(result.count, speechCount - 1000)
        XCTAssertLessThan(result.count, speechCount + 2000)
    }
}
