import Foundation
import AppKit
import UniformTypeIdentifiers

enum RecordingMode: String, CaseIterable, Identifiable {
    case pushToTalk = "Push to Talk"
    case alwaysListening = "Always Listening"
    var id: String { rawValue }
}

@MainActor
@Observable
final class SettingsViewModel {
    let mlxService: MLXService
    let whisperService: WhisperSpeechService
    private let appleSpeechService: AppleSpeechService
    private let recordingViewModel: RecordingViewModel
    private let database: AppDatabase

    var selectedEngine: SpeechEngine = .apple {
        didSet { switchEngine() }
    }

    var recordingMode: RecordingMode = .pushToTalk

    // MARK: - MLX Computed Properties

    var isDownloading: Bool {
        if case .downloading = mlxService.modelState { return true }
        return false
    }

    var downloadProgress: Double {
        if case .downloading(let progress) = mlxService.modelState { return progress }
        return 0
    }

    var statusText: String {
        switch mlxService.modelState {
        case .notDownloaded: return "Not downloaded"
        case .downloading(let progress): return "Downloading... \(Int(progress * 100))%"
        case .ready: return "Ready"
        case .error(let msg): return "Error: \(msg)"
        }
    }

    // MARK: - Whisper Computed Properties

    var isWhisperDownloading: Bool {
        if case .downloading = whisperService.modelState { return true }
        return false
    }

    var whisperDownloadProgress: Double {
        if case .downloading(let progress) = whisperService.modelState { return progress }
        return 0
    }

    var whisperStatusText: String {
        switch whisperService.modelState {
        case .notDownloaded: return "Not downloaded"
        case .downloading(let progress): return "Downloading... \(Int(progress * 100))%"
        case .ready: return "Ready"
        case .error(let msg): return "Error: \(msg)"
        }
    }

    // MARK: - Init

    init(
        mlxService: MLXService,
        whisperService: WhisperSpeechService,
        appleSpeechService: AppleSpeechService,
        recordingViewModel: RecordingViewModel,
        database: AppDatabase
    ) {
        self.mlxService = mlxService
        self.whisperService = whisperService
        self.appleSpeechService = appleSpeechService
        self.recordingViewModel = recordingViewModel
        self.database = database
    }

    // MARK: - Actions

    func downloadModel() {
        Task { @MainActor in
            do {
                try await mlxService.loadModel()
            } catch {
                print("Model download failed: \(error)")
            }
        }
    }

    func downloadWhisperModel() {
        Task { @MainActor in
            do {
                try await whisperService.downloadModel()
            } catch {
                print("Whisper model download failed: \(error)")
            }
        }
    }

    private func switchEngine() {
        switch selectedEngine {
        case .apple:
            recordingViewModel.updateSpeechService(appleSpeechService)
        case .whisper:
            recordingViewModel.updateSpeechService(whisperService)
        }
    }

    func exportNotesAsJSON() {
        Task { @MainActor in
            do {
                let notes = try database.fetchAllNotesWithDetails()
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                encoder.dateEncodingStrategy = .iso8601

                let exportData = notes.map { detail in
                    ExportNote(
                        id: detail.note.id,
                        rawTranscript: detail.note.rawTranscript,
                        processedText: detail.note.processedText,
                        summary: detail.note.summary,
                        project: detail.project?.name,
                        tags: detail.tags.map(\.name),
                        tasks: detail.tasks.map { ExportTask(title: $0.title, dueDate: $0.dueDate, isCompleted: $0.isCompleted) },
                        createdAt: detail.note.createdAt
                    )
                }

                let data = try encoder.encode(exportData)
                saveExportFile(data: data, defaultName: "echo-scribe-export.json", contentType: .json)
            } catch {
                print("JSON export failed: \(error)")
            }
        }
    }

    func exportNotesAsMarkdown() {
        Task { @MainActor in
            do {
                let notes = try database.fetchAllNotesWithDetails()
                var markdown = "# Echo Scribe Notes\n\n"
                let dateFormatter = DateFormatter()
                dateFormatter.dateStyle = .medium
                dateFormatter.timeStyle = .short

                for detail in notes {
                    markdown += "## \(detail.note.summary ?? "Untitled Note")\n"
                    markdown += "*\(dateFormatter.string(from: detail.note.createdAt))*"
                    if let project = detail.project {
                        markdown += " | Project: **\(project.name)**"
                    }
                    markdown += "\n\n"
                    markdown += detail.note.displayText + "\n\n"

                    if !detail.tags.isEmpty {
                        markdown += "Tags: " + detail.tags.map { "`\($0.name)`" }.joined(separator: ", ") + "\n\n"
                    }

                    if !detail.tasks.isEmpty {
                        markdown += "### Tasks\n"
                        for task in detail.tasks {
                            let check = task.isCompleted ? "x" : " "
                            var line = "- [\(check)] \(task.title)"
                            if let dueDate = task.dueDate {
                                line += " (due: \(dateFormatter.string(from: dueDate)))"
                            }
                            markdown += line + "\n"
                        }
                        markdown += "\n"
                    }

                    markdown += "---\n\n"
                }

                if let data = markdown.data(using: .utf8) {
                    saveExportFile(data: data, defaultName: "echo-scribe-export.md", contentType: .plainText)
                }
            } catch {
                print("Markdown export failed: \(error)")
            }
        }
    }

    private func saveExportFile(data: Data, defaultName: String, contentType: UTType) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = defaultName
        panel.allowedContentTypes = [contentType]

        if panel.runModal() == .OK, let url = panel.url {
            try? data.write(to: url)
        }
    }
}

// MARK: - Export Types

private struct ExportNote: Codable {
    let id: String
    let rawTranscript: String
    let processedText: String?
    let summary: String?
    let project: String?
    let tags: [String]
    let tasks: [ExportTask]
    let createdAt: Date
}

private struct ExportTask: Codable {
    let title: String
    let dueDate: Date?
    let isCompleted: Bool
}
