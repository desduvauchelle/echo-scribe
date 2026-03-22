import Foundation
import AppKit
import CoreData
import CoreSpotlight
import ServiceManagement
import UniformTypeIdentifiers
import Sparkle

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
    private let dictationViewModel: DictationViewModel
    private let context: NSManagedObjectContext
    let updater: SPUUpdater

    var selectedEngine: SpeechEngine = .apple {
        didSet { switchEngine() }
    }

    var selectedWhisperVariant: WhisperModelVariant = .largeTurbo
    var variantToDelete: WhisperModelVariant?

    var selectedAIVariant: AIModelVariant = .qwen3B {
        didSet { switchAIVariant() }
    }

    var recordingMode: RecordingMode = .pushToTalk

    var launchAtLogin: Bool {
        get { SMAppService.mainApp.status == .enabled }
        set {
            do {
                if newValue {
                    try SMAppService.mainApp.register()
                } else {
                    try SMAppService.mainApp.unregister()
                }
            } catch {
                print("Launch at login failed: \(error)")
            }
        }
    }

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
        dictationViewModel: DictationViewModel,
        context: NSManagedObjectContext,
        updater: SPUUpdater
    ) {
        self.mlxService = mlxService
        self.whisperService = whisperService
        self.appleSpeechService = appleSpeechService
        self.recordingViewModel = recordingViewModel
        self.dictationViewModel = dictationViewModel
        self.context = context
        self.updater = updater
        self.selectedWhisperVariant = WhisperModelVariant(rawValue: whisperService.selectedModel) ?? .largeTurbo
        self.selectedAIVariant = mlxService.selectedVariant
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

    func downloadWhisperVariant(_ variant: WhisperModelVariant) {
        Task { @MainActor in
            do {
                try await whisperService.downloadVariant(variant)
            } catch {
                print("Whisper variant download failed: \(error)")
            }
        }
    }

    func deleteWhisperVariant(_ variant: WhisperModelVariant) {
        whisperService.deleteVariant(variant)
    }

    func activateWhisperVariant(_ variant: WhisperModelVariant) {
        selectedWhisperVariant = variant
        Task { @MainActor in
            do {
                try await whisperService.activateVariant(variant)
            } catch {
                print("Whisper variant activation failed: \(error)")
            }
        }
    }

    func stateForVariant(_ variant: WhisperModelVariant) -> WhisperVariantDownloadState {
        whisperService.variantStates[variant] ?? .notDownloaded
    }

    private func switchAIVariant() {
        mlxService.switchModel(to: selectedAIVariant)
    }

    func isActiveVariant(_ variant: WhisperModelVariant) -> Bool {
        variant.rawValue == whisperService.selectedModel
    }

    private func switchEngine() {
        let service: SpeechServiceProtocol
        switch selectedEngine {
        case .apple:
            service = appleSpeechService
        case .whisper:
            service = whisperService
        }
        recordingViewModel.updateSpeechService(service)
        dictationViewModel.updateSpeechService(service)
    }

    func exportNotesAsJSON() {
        Task { @MainActor in
            let notes = fetchAllNoteDetails()
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            encoder.dateEncodingStrategy = .iso8601

            let exportData = notes.map { detail in
                ExportNote(
                    id: detail.note.id.uuidString,
                    rawTranscript: detail.note.rawTranscript,
                    processedText: detail.note.processedText,
                    summary: detail.note.summary,
                    project: detail.project?.name,
                    tags: detail.tags.map(\.name),
                    tasks: detail.tasks.map { ExportTask(title: $0.title, dueDate: $0.dueDate, isCompleted: $0.isCompleted) },
                    createdAt: detail.note.createdAt
                )
            }

            do {
                let data = try encoder.encode(exportData)
                saveExportFile(data: data, defaultName: "echo-scribe-export.json", contentType: .json)
            } catch {
                print("JSON export failed: \(error)")
            }
        }
    }

    func exportNotesAsMarkdown() {
        Task { @MainActor in
            let notes = fetchAllNoteDetails()
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
        }
    }

    private func fetchAllNoteDetails() -> [NoteWithDetails] {
        let request: NSFetchRequest<CDNote> = CDNote.fetchRequest()
        request.sortDescriptors = [NSSortDescriptor(key: "createdAt", ascending: false)]
        request.relationshipKeyPathsForPrefetching = ["project", "tags", "tasks"]
        let notes = (try? context.fetch(request)) ?? []
        return notes.map(NoteWithDetails.from)
    }

    private func saveExportFile(data: Data, defaultName: String, contentType: UTType) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = defaultName
        panel.allowedContentTypes = [contentType]

        if panel.runModal() == .OK, let url = panel.url {
            try? data.write(to: url)
        }
    }

    // MARK: - Uninstall

    func performUninstall() {
        let fm = FileManager.default

        // 1. Remove Spotlight index
        Task {
            try? await CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: ["com.echoscribe.notes"])
        }

        // 2. Disable Launch at Login
        try? SMAppService.mainApp.unregister()

        // 3. Delete WhisperKit models
        if let documentsDir = fm.urls(for: .documentDirectory, in: .userDomainMask).first {
            let whisperDir = documentsDir.appendingPathComponent("huggingface/models/argmaxinc/whisperkit-coreml")
            try? fm.removeItem(at: whisperDir)
        }

        // 4. Delete Core Data database
        if let appSupportDir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            let dbDir = appSupportDir.appendingPathComponent("EchoScribe")
            try? fm.removeItem(at: dbDir)
        }

        // 5. Delete MLX / HuggingFace model cache
        let homeDir = fm.homeDirectoryForCurrentUser
        let hfCacheDir = homeDir.appendingPathComponent(".cache/huggingface")
        if fm.fileExists(atPath: hfCacheDir.path) {
            try? fm.removeItem(at: hfCacheDir)
        }

        // 6. Delete app preferences
        if let bundleId = Bundle.main.bundleIdentifier {
            UserDefaults.standard.removePersistentDomain(forName: bundleId)
        }

        // 7. Quit
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            NSApplication.shared.terminate(nil)
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
