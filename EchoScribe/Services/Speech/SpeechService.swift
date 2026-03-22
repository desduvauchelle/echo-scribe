import Foundation

struct TranscriptionUpdate: Sendable {
    let partialText: String
    let isFinal: Bool
    let confidence: Float
}

enum SpeechEngine: String, CaseIterable, Identifiable {
    case apple = "Apple Speech"
    case whisper = "Whisper (Local)"

    var id: String { rawValue }
}

@MainActor
protocol SpeechServiceProtocol: AnyObject {
    var isRecording: Bool { get }
    func startRecording() async throws
    func stopRecording() async -> String
    func transcriptionUpdates() -> AsyncStream<TranscriptionUpdate>
}

enum SpeechError: LocalizedError {
    case notAuthorized
    case recognizerUnavailable
    case whisperModelNotLoaded

    var errorDescription: String? {
        switch self {
        case .notAuthorized:
            return "Speech recognition is not authorized. Please enable it in System Settings > Privacy & Security."
        case .recognizerUnavailable:
            return "Speech recognizer is not available for the current locale."
        case .whisperModelNotLoaded:
            return "Whisper model is not downloaded. Please download it in Settings."
        }
    }
}
