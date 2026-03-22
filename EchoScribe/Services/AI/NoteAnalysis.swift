import Foundation

struct NoteAnalysis: Codable {
    let processedText: String
    let summary: String
    let tasks: [ExtractedTask]
    let project: String
    let tags: [String]

    struct ExtractedTask: Codable {
        let title: String
        let dueDate: String?
    }
}
