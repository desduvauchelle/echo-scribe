import Foundation
import Speech
import os

enum TranscriptionError: Error {
    case notAuthorized
    case noSpeechDetected
    case failed(Error)
}

final class AppleTranscriber {
    private let logger = Logger(subsystem: "com.echoscribe.app", category: "AppleTranscriber")

    func requestPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }

    /// Transcribe an audio file on-device. Returns the transcribed text.
    func transcribe(audioURL: URL) async throws -> String {
        let authorized = await requestPermission()
        guard authorized else { throw TranscriptionError.notAuthorized }

        guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en_US")) else {
            throw TranscriptionError.failed(NSError(domain: "AppleTranscriber", code: 1, userInfo: [NSLocalizedDescriptionKey: "No speech recognizer available"]))
        }

        let request = SFSpeechURLRecognitionRequest(url: audioURL)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false

        return try await withCheckedThrowingContinuation { continuation in
            recognizer.recognitionTask(with: request) { [weak self] result, error in
                if let error {
                    self?.logger.error("Transcription failed: \(error.localizedDescription)")
                    continuation.resume(throwing: TranscriptionError.failed(error))
                    return
                }
                guard let result, result.isFinal else { return }
                let text = result.bestTranscription.formattedString
                if text.isEmpty {
                    continuation.resume(throwing: TranscriptionError.noSpeechDetected)
                } else {
                    self?.logger.info("Transcribed: \(text)")
                    continuation.resume(returning: text)
                }
            }
        }
    }
}
