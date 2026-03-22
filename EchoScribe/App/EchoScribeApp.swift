import SwiftUI
import KeyboardShortcuts

@main
struct EchoScribeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    private let database = AppDatabase.shared
    @State private var feedViewModel: FeedViewModel
    @State private var recordingViewModel: RecordingViewModel
    @State private var projectsViewModel: ProjectsViewModel
    @State private var settingsViewModel: SettingsViewModel
    @State private var menuBarManager = MenuBarManager()
    @State private var spotlightIndexer = SpotlightIndexer()
    @State private var appState = AppState()

    init() {
        let db = AppDatabase.shared
        let mlx = MLXService()
        let pipeline = NoteProcessingPipeline(database: db, mlxService: mlx)
        let appleSpeechService = AppleSpeechService()
        let whisperService = WhisperSpeechService()

        let recordingVM = RecordingViewModel(
            speechService: appleSpeechService,
            pipeline: pipeline
        )

        _feedViewModel = State(initialValue: FeedViewModel(database: db))
        _recordingViewModel = State(initialValue: recordingVM)
        _projectsViewModel = State(initialValue: ProjectsViewModel(database: db))
        _settingsViewModel = State(initialValue: SettingsViewModel(
            mlxService: mlx,
            whisperService: whisperService,
            appleSpeechService: appleSpeechService,
            recordingViewModel: recordingVM,
            database: db
        ))
    }

    var body: some Scene {
        WindowGroup {
            ContentView(
                feedViewModel: feedViewModel,
                recordingViewModel: recordingViewModel,
                projectsViewModel: projectsViewModel,
                appState: appState
            )
            .onAppear {
                KeyboardShortcuts.onKeyUp(for: .toggleRecording) { [self] in
                    recordingViewModel.toggleRecording()
                }
                menuBarManager.configure(recordingViewModel: recordingViewModel)
                AppDelegate.toggleRecordingHandler = { [self] in
                    recordingViewModel.toggleRecording()
                }
                AppDelegate.showWindowHandler = {
                    NSApplication.shared.activate(ignoringOtherApps: true)
                    if let window = NSApplication.shared.windows.first {
                        window.makeKeyAndOrderFront(nil)
                    }
                }
                spotlightIndexer.indexNotes(feedViewModel.notes)
            }
            .onChange(of: recordingViewModel.isRecording) { _, isRecording in
                menuBarManager.updateRecordingState(isRecording: isRecording)
            }
            .onChange(of: feedViewModel.notes) { _, newNotes in
                spotlightIndexer.indexNotes(newNotes)
            }
        }
        .defaultSize(width: 900, height: 650)

        Settings {
            SettingsView(viewModel: settingsViewModel, menuBarManager: menuBarManager)
        }
    }
}
