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
        UserDefaults.standard.register(defaults: [
            Constants.removeSilenceKey: true
        ])

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
    @AppStorage("doublePressAction") private var doublePressActionRaw: String = DoublePressAction.off.rawValue
    @AppStorage("doublePressKey") private var doublePressKeyRaw: String = DoublePressKey.option.rawValue

    private var capsLockMode: CapsLockMode {
        CapsLockMode(rawValue: capsLockModeRaw) ?? .off
    }

    private var doublePressAction: DoublePressAction {
        DoublePressAction(rawValue: doublePressActionRaw) ?? .off
    }

    private var doublePressKey: DoublePressKey {
        DoublePressKey(rawValue: doublePressKeyRaw) ?? .option
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
                // Request accessibility once at launch (shows system prompt if needed)
                ClipboardPasteService.requestAccessibilityIfNeeded()
            }
            .onChange(of: capsLockModeRaw) { _, _ in
                setupShortcuts()
            }
            .onChange(of: doublePressActionRaw) { _, _ in
                setupShortcuts()
            }
            .onChange(of: doublePressKeyRaw) { _, _ in
                setupShortcuts()
            }
            .onChange(of: recordingViewModel.isRecording) { _, isRecording in
                MenuBarManager.shared.updateRecordingState(isRecording: isRecording)
            }
            .onChange(of: dictationViewModel.isRecording) { _, isDictating in
                if isDictating {
                    dictationIndicator.show()
                } else if !dictationViewModel.isTranscribing {
                    dictationIndicator.dismiss()
                    // Show toast if text was copied to clipboard (no auto-paste)
                    if dictationViewModel.lastPasteResult == .copiedToClipboard {
                        dictationIndicator.showToast("Copied to clipboard \u{2014} Cmd+V to paste")
                    }
                }
                MenuBarManager.shared.updateDictationState(isDictating: isDictating)
            }
            .onChange(of: dictationViewModel.isTranscribing) { _, isTranscribing in
                if isTranscribing {
                    dictationIndicator.showTranscribing()
                } else {
                    dictationIndicator.dismiss()
                    if dictationViewModel.lastPasteResult == .copiedToClipboard {
                        dictationIndicator.showToast("Copied to clipboard \u{2014} Cmd+V to paste")
                    }
                }
            }
            .onChange(of: feedViewModel.notes) { _, newNotes in
                spotlightIndexer.indexNotes(newNotes)
            }
        }
        .defaultSize(width: 900, height: 650)
    }

    private func setupShortcuts() {
        let capsLockService = CapsLockShortcutService.shared
        let doublePressService = DoublePressShortcutService.shared

        // Reset all caps lock callbacks
        capsLockService.stop()
        capsLockService.onCapsLockToggled = nil
        capsLockService.onCapsLockDown = nil
        capsLockService.onCapsLockUp = nil

        // Reset double-press service
        doublePressService.stop()
        doublePressService.onDoublePress = nil

        // Track which actions are handled by special triggers
        let voiceToNoteCapsLock = capsLockMode == .voiceToNote
        let transcribeCapsLock = capsLockMode == .transcribe
        let voiceToNoteDoublePress = doublePressAction == .voiceToNote && !voiceToNoteCapsLock
        let transcribeDoublePress = doublePressAction == .transcribe && !transcribeCapsLock

        // --- Caps Lock setup ---
        switch capsLockMode {
        case .voiceToNote:
            capsLockService.onCapsLockToggled = { [self] in
                recordingViewModel.toggleRecording()
            }
            capsLockService.start()

        case .transcribe:
            capsLockService.onCapsLockDown = { [self] in
                Task { @MainActor in await dictationViewModel.startDictation() }
            }
            capsLockService.onCapsLockUp = { [self] in
                Task { @MainActor in await dictationViewModel.stopDictationAndPaste() }
            }
            capsLockService.start()

        case .off:
            break
        }

        // --- Double-press setup ---
        if voiceToNoteDoublePress {
            doublePressService.monitoredKey = doublePressKey
            doublePressService.onDoublePress = { [self] in
                recordingViewModel.toggleRecording()
            }
            doublePressService.start()
        } else if transcribeDoublePress {
            doublePressService.monitoredKey = doublePressKey
            doublePressService.onDoublePress = { [self] in
                Task { @MainActor in
                    if dictationViewModel.isRecording {
                        await dictationViewModel.stopDictationAndPaste()
                    } else {
                        await dictationViewModel.startDictation()
                    }
                }
            }
            doublePressService.start()
        }

        // --- Keyboard shortcuts ---
        // Voice to Note: use keyboard shortcut unless handled by caps lock or double-press
        if voiceToNoteCapsLock || voiceToNoteDoublePress {
            KeyboardShortcuts.onKeyUp(for: .toggleRecording) { }
        } else {
            KeyboardShortcuts.onKeyUp(for: .toggleRecording) { [self] in
                recordingViewModel.toggleRecording()
            }
        }

        // Transcribe: use keyboard shortcut unless handled by caps lock or double-press
        if transcribeCapsLock || transcribeDoublePress {
            KeyboardShortcuts.onKeyDown(for: .dictationMode) { }
            KeyboardShortcuts.onKeyUp(for: .dictationMode) { }
        } else {
            KeyboardShortcuts.onKeyDown(for: .dictationMode) { [self] in
                Task { @MainActor in await dictationViewModel.startDictation() }
            }
            KeyboardShortcuts.onKeyUp(for: .dictationMode) { [self] in
                Task { @MainActor in await dictationViewModel.stopDictationAndPaste() }
            }
        }
    }
}
