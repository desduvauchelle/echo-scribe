import SwiftUI
import KeyboardShortcuts
import Sparkle

@main
struct EchoScribeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    private let persistence = PersistenceController.shared
    @State private var feedViewModel: FeedViewModel
    @State private var recordingViewModel: RecordingViewModel
    @State private var dictationViewModel: DictationViewModel
    @State private var projectsViewModel: ProjectsViewModel
    @State private var settingsViewModel: SettingsViewModel
    @State private var spotlightIndexer = SpotlightIndexer()
    @State private var appState: AppState
    @State private var audioDeviceManager: AudioDeviceManager
    @State private var dictationIndicator = DictationIndicatorWindow()
    private let updaterController: SPUStandardUpdaterController

    init() {
        #if DEBUG
        self.updaterController = SPUStandardUpdaterController(
            startingUpdater: false,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
        #else
        self.updaterController = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
        #endif
        let persistence = PersistenceController.shared
        let ctx = persistence.viewContext
        let mlx = MLXService()
        let pipeline = NoteProcessingPipeline(persistence: persistence, mlxService: mlx)
        let deviceManager = AudioDeviceManager()
        let appleSpeechService = AppleSpeechService()
        appleSpeechService.audioDeviceManager = deviceManager
        let whisperService = WhisperSpeechService()
        whisperService.audioDeviceManager = deviceManager
        let parakeetService = ParakeetSpeechService()
        parakeetService.audioDeviceManager = deviceManager
        let coordinator = RecordingCoordinator()

        let recordingVM = RecordingViewModel(
            speechService: appleSpeechService,
            pipeline: pipeline,
            coordinator: coordinator
        )

        let dictationVM = DictationViewModel(
            speechService: appleSpeechService,
            coordinator: coordinator
        )

        _feedViewModel = State(initialValue: FeedViewModel(context: ctx))
        _recordingViewModel = State(initialValue: recordingVM)
        _dictationViewModel = State(initialValue: dictationVM)
        _projectsViewModel = State(initialValue: ProjectsViewModel(context: ctx))
        _settingsViewModel = State(initialValue: SettingsViewModel(
            mlxService: mlx,
            whisperService: whisperService,
            parakeetService: parakeetService,
            appleSpeechService: appleSpeechService,
            recordingViewModel: recordingVM,
            dictationViewModel: dictationVM,
            context: ctx,
            updater: updaterController.updater
        ))

        // Configure the singleton menu bar manager
        MenuBarManager.shared.configure(recordingViewModel: recordingVM, dictationViewModel: dictationVM)

        // Wire menu bar action handlers
        AppDelegate.toggleRecordingHandler = {
            recordingVM.toggleRecording()
        }
        AppDelegate.toggleDictationHandler = {
            Task { @MainActor in
                if dictationVM.isRecording {
                    await dictationVM.stopDictationAndPaste()
                } else {
                    await dictationVM.startDictation()
                }
            }
        }
        AppDelegate.showWindowHandler = {
            // Activation and focus handled by AppDelegate.showMainWindow()
        }
        let state = AppState()
        _appState = State(initialValue: state)
        _audioDeviceManager = State(initialValue: deviceManager)
        AppDelegate.openSettingsHandler = {
            // Activation and focus handled by AppDelegate.openSettings()
            state.currentViewMode = .settings
        }

        let updater = updaterController
        AppDelegate.checkForUpdatesHandler = {
            updater.checkForUpdates(nil)
        }
    }

    @AppStorage("capsLockMode") private var capsLockModeRaw: String = CapsLockMode.off.rawValue

    private var capsLockMode: CapsLockMode {
        CapsLockMode(rawValue: capsLockModeRaw) ?? .off
    }

    var body: some Scene {
        WindowGroup {
            ContentView(
                feedViewModel: feedViewModel,
                recordingViewModel: recordingViewModel,
                projectsViewModel: projectsViewModel,
                settingsViewModel: settingsViewModel,
                appState: appState,
                audioDeviceManager: audioDeviceManager
            )
            .environment(\.managedObjectContext, persistence.viewContext)
            .onAppear {
                setupShortcuts()
                spotlightIndexer.indexNotes(feedViewModel.notes)
            }
            .onChange(of: capsLockModeRaw) { _, _ in
                setupShortcuts()
            }
            .onChange(of: recordingViewModel.isRecording) { _, isRecording in
                MenuBarManager.shared.updateRecordingState(isRecording: isRecording)
            }
            .onChange(of: dictationViewModel.isRecording) { _, isDictating in
                if isDictating {
                    dictationIndicator.show()
                } else {
                    dictationIndicator.dismiss()
                }
                MenuBarManager.shared.updateDictationState(isDictating: isDictating)
            }
            .onChange(of: feedViewModel.notes) { _, newNotes in
                spotlightIndexer.indexNotes(newNotes)
            }
        }
        .defaultSize(width: 900, height: 650)
    }

    private func setupShortcuts() {
        let capsLockService = CapsLockShortcutService.shared

        // Reset all caps lock callbacks
        capsLockService.stop()
        capsLockService.onCapsLockToggled = nil
        capsLockService.onCapsLockDown = nil
        capsLockService.onCapsLockUp = nil

        switch capsLockMode {
        case .voiceToNote:
            // Caps Lock for Voice to Note (toggle mode)
            KeyboardShortcuts.onKeyUp(for: .toggleRecording) { }
            capsLockService.onCapsLockToggled = { [self] in
                recordingViewModel.toggleRecording()
            }
            capsLockService.start()

            // Normal keyboard shortcut for Dictation
            KeyboardShortcuts.onKeyDown(for: .dictationMode) { [self] in
                Task { @MainActor in await dictationViewModel.startDictation() }
            }
            KeyboardShortcuts.onKeyUp(for: .dictationMode) { [self] in
                Task { @MainActor in await dictationViewModel.stopDictationAndPaste() }
            }

        case .transcribe:
            // Caps Lock for Transcribe (hold mode — press to start, press again to stop)
            KeyboardShortcuts.onKeyDown(for: .dictationMode) { }
            KeyboardShortcuts.onKeyUp(for: .dictationMode) { }
            capsLockService.onCapsLockDown = { [self] in
                Task { @MainActor in await dictationViewModel.startDictation() }
            }
            capsLockService.onCapsLockUp = { [self] in
                Task { @MainActor in await dictationViewModel.stopDictationAndPaste() }
            }
            capsLockService.start()

            // Normal keyboard shortcut for Voice to Note
            KeyboardShortcuts.onKeyUp(for: .toggleRecording) { [self] in
                recordingViewModel.toggleRecording()
            }

        case .off:
            // Normal keyboard shortcuts for both
            KeyboardShortcuts.onKeyUp(for: .toggleRecording) { [self] in
                recordingViewModel.toggleRecording()
            }
            KeyboardShortcuts.onKeyDown(for: .dictationMode) { [self] in
                Task { @MainActor in await dictationViewModel.startDictation() }
            }
            KeyboardShortcuts.onKeyUp(for: .dictationMode) { [self] in
                Task { @MainActor in await dictationViewModel.stopDictationAndPaste() }
            }
        }
    }
}
