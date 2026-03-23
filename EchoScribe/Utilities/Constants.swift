import Foundation
import KeyboardShortcuts

enum Constants {
    static let appName = "Echo Scribe"
    static let defaultProjectName = "General"
    static let maxTranscriptPreviewLength = 200
    static let selectedAIModelKey = "selectedAIModel"
    static let selectedSpeechEngineKey = "selectedSpeechEngine"
    static let selectedWhisperVariantKey = "selectedWhisperVariant"
    static let selectedParakeetVariantKey = "selectedParakeetVariant"
    static let recordingModeKey = "recordingMode"
    static let selectedMicrophoneUID = "selectedMicrophoneUID"
    static let microphonePreferenceOrder = "microphonePreferenceOrder"
}

extension KeyboardShortcuts.Name {
    static let toggleRecording = Self("toggleRecording", default: .init(.space, modifiers: .option))
    static let dictationMode = Self("dictationMode", default: .init(.d, modifiers: .option))
}
