import AudioCommon
import Foundation

/// Turns PersonaPlex "inner monologue" text tokens into printable pieces one
/// token at a time. (The library's batch decoder trims whitespace, which would
/// glue streamed words together.)
struct StreamingTextDecoder: Sendable {
    private let model: SentencePieceModel

    /// Emitted while the model produces audio without text.
    static let textPaddingId: Int32 = 3

    init(modelPath: String) throws {
        model = try SentencePieceModel(modelPath: modelPath)
    }

    func piece(for token: Int32) -> String? {
        if token == Self.textPaddingId || token < 0 { return nil }
        guard let p = model[Int(token)] else { return nil }
        if p.isControlOrUnknown { return nil }
        if p.text.hasPrefix("<") && p.text.hasSuffix(">") { return nil }
        let text = p.text.replacingOccurrences(of: "\u{2581}", with: " ")
        return text.isEmpty ? nil : text
    }
}
