import Foundation
import KeyboardShortcuts

enum Constants {
    static let appName = "Echo Scribe"
    static let defaultProjectName = "General"
    static let maxTranscriptPreviewLength = 200
}

extension KeyboardShortcuts.Name {
    static let toggleRecording = Self("toggleRecording", default: .init(.space, modifiers: .option))
}
