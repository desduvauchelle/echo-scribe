import SwiftUI
import KeyboardShortcuts
import Sparkle

enum SettingsTab: String, CaseIterable, Identifiable {
    case general = "General"
    case shortcuts = "Shortcuts"
    case voice = "Voice"
    case ai = "AI"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .general: return "gear"
        case .shortcuts: return "keyboard"
        case .voice: return "waveform"
        case .ai: return "brain"
        }
    }
}

struct SettingsView: View {
    @Bindable var viewModel: SettingsViewModel
    @Bindable var audioDeviceManager: AudioDeviceManager
    var onDismiss: (() -> Void)? = nil
    @Environment(\.colorScheme) private var colorScheme

    @State private var selectedTab: SettingsTab = .general
    @State private var toggleRecordingConflicts: [ShortcutConflict] = []
    @State private var dictationModeConflicts: [ShortcutConflict] = []
    @State private var showDisableConfirmation = false
    @State private var pendingDisableID: Int?
    @State private var pendingDisableName = ""
    @State private var showUninstallAlert = false
    @State private var showFinalUninstallConfirmation = false
    @AppStorage("capsLockMode") private var capsLockModeRaw: String = CapsLockMode.off.rawValue
    @AppStorage("doublePressAction") private var doublePressActionRaw: String = DoublePressAction.off.rawValue
    @AppStorage("doublePressKey") private var doublePressKeyRaw: String = DoublePressKey.option.rawValue
    @State private var isAccessibilityGranted = false
    @AppStorage("useAIImprovements") private var useAIImprovements = false
    // Key must match Constants.removeSilenceKey
    @AppStorage("removeSilence") private var removeSilence = true
    private let conflictDetector = ShortcutConflictDetector()

    var body: some View {
        VStack(spacing: Spacing.lg) {
            HStack {
                Button {
                    onDismiss?()
                } label: {
                    Label("Back", systemImage: "chevron.left")
                }
                .buttonStyle(.plain)
                Spacer()
            }

            Text("Settings")
                .font(.title2)
                .fontWeight(.semibold)
                .frame(maxWidth: .infinity, alignment: .leading)

            Picker("", selection: $selectedTab) {
                ForEach(SettingsTab.allCases) { tab in
                    Label(tab.rawValue, systemImage: tab.icon).tag(tab)
                }
            }
            .pickerStyle(.segmented)

            ScrollView {
                VStack(spacing: Spacing.lg) {
                    switch selectedTab {
                    case .general:
                        generalSection
                        updatesSection
                        dataSection
                        uninstallSection
                    case .shortcuts:
                        keyboardShortcutsSection
                    case .voice:
                        microphoneSection
                        voiceToTextSection
                        silenceRemovalSection
                        aiImprovementsSection
                    case .ai:
                        aiModelSection
                    }
                }
                .animation(AppAnimation.gentle, value: selectedTab)
            }

            Spacer(minLength: 0)
        }
        .padding(.top, Spacing.md)
        .alert("Uninstall Echo Scribe", isPresented: $showUninstallAlert) {
            Button("Cancel", role: .cancel) {}
            Button("Delete All & Quit", role: .destructive) {
                showFinalUninstallConfirmation = true
            }
        } message: {
            Text("This will permanently delete:\n\n\u{2022} All notes, projects, and tags\n\u{2022} Downloaded Whisper speech models\n\u{2022} Downloaded AI processing model\n\u{2022} Spotlight index entries\n\u{2022} App preferences\n\nYou will need to move Echo Scribe to the Trash yourself.\n\nThis cannot be undone.")
        }
        .alert("Are you sure?", isPresented: $showFinalUninstallConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Delete Everything & Quit", role: .destructive) {
                viewModel.performUninstall()
            }
        } message: {
            Text("All your data will be permanently deleted. This action cannot be undone.")
        }
    }

    // MARK: - General

    private var generalSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("GENERAL")
                .sectionLabel()

            VStack(spacing: Spacing.md) {
                Toggle("Launch at Login", isOn: $viewModel.launchAtLogin)
                    .foregroundStyle(.secondary)
            }
            .padding(Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Radius.md)
                    .fill(AppColors.surface)
            )
            .modifier(Elevation.card(colorScheme))
        }
    }

    // MARK: - Updates

    private var updatesSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("UPDATES")
                .sectionLabel()

            VStack(spacing: Spacing.md) {
                HStack {
                    Text("Current Version")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Divider()

                HStack {
                    Toggle("Check Automatically", isOn: Binding(
                        get: { viewModel.updater.automaticallyChecksForUpdates },
                        set: { viewModel.updater.automaticallyChecksForUpdates = $0 }
                    ))
                    .foregroundStyle(.secondary)
                }

                Divider()

                HStack {
                    Spacer()
                    Button("Check for Updates") {
                        viewModel.updater.checkForUpdates()
                    }
                    .controlSize(.small)
                }
            }
            .padding(Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Radius.md)
                    .fill(AppColors.surface)
            )
            .modifier(Elevation.card(colorScheme))
        }
    }

    // MARK: - Microphone

    @State private var microphoneOrder: [AudioInputDevice] = []

    private var microphoneSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("MICROPHONE")
                .sectionLabel()

            VStack(spacing: 0) {
                if microphoneOrder.isEmpty {
                    Text("No input devices found")
                        .foregroundStyle(.tertiary)
                        .padding(Spacing.md)
                } else {
                    ForEach(Array(microphoneOrder.enumerated()), id: \.element.uid) { index, device in
                        VStack(spacing: 0) {
                            if index > 0 {
                                Divider()
                            }
                            HStack(spacing: Spacing.sm) {
                                Circle()
                                    .fill(audioDeviceManager.availableDevices.contains(where: { $0.uid == device.uid }) ? Color.green : Color.gray)
                                    .frame(width: 8, height: 8)

                                Text(device.name)
                                    .foregroundStyle(audioDeviceManager.availableDevices.contains(where: { $0.uid == device.uid }) ? .primary : .tertiary)

                                if !audioDeviceManager.availableDevices.contains(where: { $0.uid == device.uid }) {
                                    Text("(Disconnected)")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }

                                Spacer()

                                if index == 0 {
                                    Text("Priority")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .padding(.horizontal, Spacing.xs)
                                        .padding(.vertical, 2)
                                        .background(
                                            RoundedRectangle(cornerRadius: Radius.sm)
                                                .fill(Color.accentColor.opacity(0.15))
                                        )
                                }

                                Button {
                                    moveMicrophoneUp(index: index)
                                } label: {
                                    Image(systemName: "chevron.up")
                                        .font(.caption)
                                }
                                .buttonStyle(.plain)
                                .disabled(index == 0)
                                .opacity(index == 0 ? 0.3 : 1)

                                Button {
                                    moveMicrophoneDown(index: index)
                                } label: {
                                    Image(systemName: "chevron.down")
                                        .font(.caption)
                                }
                                .buttonStyle(.plain)
                                .disabled(index == microphoneOrder.count - 1)
                                .opacity(index == microphoneOrder.count - 1 ? 0.3 : 1)
                            }
                            .padding(Spacing.md)
                        }
                    }
                }

                Divider()

                HStack {
                    Text("When a preferred microphone disconnects, the next available one is used automatically.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Spacer()
                    Button("Reset") {
                        audioDeviceManager.resetPreferences()
                        microphoneOrder = audioDeviceManager.getPreferenceOrder()
                    }
                    .controlSize(.small)
                }
                .padding(Spacing.md)
            }
            .background(
                RoundedRectangle(cornerRadius: Radius.md)
                    .fill(AppColors.surface)
            )
            .modifier(Elevation.card(colorScheme))
        }
        .onAppear {
            microphoneOrder = audioDeviceManager.getPreferenceOrder()
        }
    }

    private func moveMicrophoneUp(index: Int) {
        guard index > 0 else { return }
        microphoneOrder.swapAt(index, index - 1)
        audioDeviceManager.savePreferenceOrder(microphoneOrder)
    }

    private func moveMicrophoneDown(index: Int) {
        guard index < microphoneOrder.count - 1 else { return }
        microphoneOrder.swapAt(index, index + 1)
        audioDeviceManager.savePreferenceOrder(microphoneOrder)
    }

    // MARK: - Voice to Text

    private var voiceToTextSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("VOICE TO TEXT")
                .sectionLabel()

            VStack(spacing: Spacing.md) {
                HStack {
                    Text("Engine")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Picker("", selection: $viewModel.selectedEngine) {
                        ForEach(SpeechEngine.allCases) { engine in
                            Text(engine.rawValue).tag(engine)
                        }
                    }
                    .pickerStyle(.menu)
                    .frame(width: 200)
                }
            }
            .padding(Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Radius.md)
                    .fill(AppColors.surface)
            )
            .modifier(Elevation.card(colorScheme))

            if viewModel.selectedEngine == .whisper {
                Text("MODELS")
                    .sectionLabel()
                    .padding(.top, Spacing.xs)

                VStack(spacing: Spacing.sm) {
                    ForEach(WhisperModelVariant.allCases) { variant in
                        whisperModelCard(for: variant)
                    }
                }
                .alert(
                    "Delete Model",
                    isPresented: Binding(
                        get: { viewModel.variantToDelete != nil },
                        set: { if !$0 { viewModel.variantToDelete = nil } }
                    )
                ) {
                    Button("Delete", role: .destructive) {
                        if let variant = viewModel.variantToDelete {
                            viewModel.deleteWhisperVariant(variant)
                        }
                        viewModel.variantToDelete = nil
                    }
                    Button("Cancel", role: .cancel) {
                        viewModel.variantToDelete = nil
                    }
                } message: {
                    if let variant = viewModel.variantToDelete {
                        Text("Remove the \(variant.displayName) model (\(variant.formattedSize)) from disk?")
                    }
                }
            }

            if viewModel.selectedEngine == .parakeet {
                Text("MODELS")
                    .sectionLabel()
                    .padding(.top, Spacing.xs)

                VStack(spacing: Spacing.sm) {
                    ForEach(ParakeetModelVariant.allCases) { variant in
                        parakeetModelCard(for: variant)
                    }
                }

                Text("NVIDIA Parakeet TDT 0.6B — runs locally on Apple Neural Engine. Licensed under CC-BY-4.0.")
                    .font(.caption2)
                    .foregroundStyle(.quaternary)
            }
        }
    }

    private func whisperModelCard(for variant: WhisperModelVariant) -> some View {
        let state = viewModel.stateForVariant(variant)
        let isActive = viewModel.isActiveVariant(variant)

        return HStack(spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                HStack(spacing: Spacing.sm) {
                    Text(variant.displayName)
                        .font(.headline)
                        .fontWeight(.medium)

                    if isActive {
                        Text("Active")
                            .pillStyle()
                    }

                    if case .downloaded = state, !isActive {
                        Circle()
                            .fill(.green)
                            .frame(width: 6, height: 6)
                    }
                }

                VStack(spacing: 3) {
                    ComparisonBar(label: "Accuracy", value: variant.accuracyScore, color: .green)
                    ComparisonBar(label: "Speed", value: variant.speedScore, color: .blue)
                    ComparisonBar(label: "Size", value: variant.normalizedSize, color: .orange, suffix: variant.formattedSize)
                }

                if case .downloading(let progress) = state {
                    ProgressView(value: progress)
                        .tint(.accentColor)
                }
            }

            Spacer(minLength: 0)

            switch state {
            case .notDownloaded:
                Button {
                    viewModel.activateWhisperVariant(variant)
                } label: {
                    Image(systemName: "arrow.down.circle")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Download and activate")

            case .downloading:
                ProgressView()
                    .controlSize(.small)

            case .downloaded:
                if !isActive {
                    Button {
                        viewModel.variantToDelete = variant
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .help("Delete model")
                }

            case .error:
                Button {
                    viewModel.downloadWhisperVariant(variant)
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.title3)
                        .foregroundStyle(.red)
                }
                .buttonStyle(.plain)
                .help("Retry download")
            }
        }
        .cardStyle(isSelected: isActive)
        .contentShape(Rectangle())
        .onTapGesture {
            if case .downloaded = state, !isActive {
                viewModel.activateWhisperVariant(variant)
            }
        }
    }

    private func parakeetModelCard(for variant: ParakeetModelVariant) -> some View {
        let isActive = variant == viewModel.selectedParakeetVariant
        let modelState = isActive ? viewModel.parakeetService.modelState : .notDownloaded

        return HStack(spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                HStack(spacing: Spacing.sm) {
                    Text(variant.displayName)
                        .font(.headline)
                        .fontWeight(.medium)

                    if isActive {
                        Text("Active")
                            .pillStyle()
                    }

                    if isActive, case .ready = modelState {
                        Circle()
                            .fill(.green)
                            .frame(width: 6, height: 6)
                    }
                }

                VStack(spacing: 3) {
                    ComparisonBar(label: "Accuracy", value: variant.accuracyScore, color: .green)
                    ComparisonBar(label: "Speed", value: variant.speedScore, color: .blue)
                    ComparisonBar(label: "Size", value: variant.normalizedSize, color: .orange, suffix: variant.formattedSize)
                }

                if isActive, case .downloading(let progress) = modelState {
                    ProgressView(value: progress)
                        .tint(.accentColor)
                }
            }

            Spacer(minLength: 0)

            if isActive {
                switch modelState {
                case .notDownloaded:
                    Button {
                        viewModel.downloadParakeetModel()
                    } label: {
                        Image(systemName: "arrow.down.circle")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help("Download model")

                case .downloading:
                    ProgressView()
                        .controlSize(.small)

                case .ready:
                    EmptyView()

                case .error:
                    Button {
                        viewModel.downloadParakeetModel()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.title3)
                            .foregroundStyle(.red)
                    }
                    .buttonStyle(.plain)
                    .help("Retry download")
                }
            }
        }
        .cardStyle(isSelected: isActive)
        .contentShape(Rectangle())
        .onTapGesture {
            if !isActive {
                viewModel.selectedParakeetVariant = variant
            }
        }
    }

    // MARK: - Silence Removal

    private var silenceRemovalSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("AUDIO PROCESSING")
                .sectionLabel()

            VStack(spacing: Spacing.md) {
                Toggle("Remove silence", isOn: $removeSilence)
                    .foregroundStyle(.secondary)

                Text("Strips long pauses from audio before transcription. Reduces hallucinated text during silence. Only affects Whisper and Parakeet engines.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding(Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Radius.md)
                    .fill(AppColors.surface)
            )
            .modifier(Elevation.card(colorScheme))
        }
    }

    // MARK: - AI Improvements

    private var aiImprovementsSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("AI POLISHING")
                .sectionLabel()

            VStack(spacing: Spacing.md) {
                Toggle("Use AI improvements", isOn: $useAIImprovements)
                    .foregroundStyle(.secondary)

                Text("When enabled, transcriptions are lightly polished by the AI model — fixing grammar, filler words, and punctuation.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding(Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Radius.md)
                    .fill(AppColors.surface)
            )
            .modifier(Elevation.card(colorScheme))
        }
    }

    // MARK: - Keyboard Shortcuts

    private var capsLockMode: CapsLockMode {
        CapsLockMode(rawValue: capsLockModeRaw) ?? .off
    }

    private var doublePressAction: DoublePressAction {
        DoublePressAction(rawValue: doublePressActionRaw) ?? .off
    }

    private var doublePressKey: DoublePressKey {
        DoublePressKey(rawValue: doublePressKeyRaw) ?? .option
    }

    private var capsLockBadge: some View {
        Text("Caps Lock")
            .font(.system(.body, design: .rounded).weight(.medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: Radius.sm)
                    .fill(AppColors.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: Radius.sm)
                            .stroke(Color.secondary.opacity(0.3), lineWidth: 1)
                    )
            )
    }

    private var capsLockInfoBox: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(.blue)
                .font(.caption)
            Text("Caps Lock is a toggle key — press once to start, press again to stop. While enabled, Caps Lock will not change letter casing. Requires Accessibility permission.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: Radius.sm)
                .fill(Color.blue.opacity(0.08))
        )
    }

    private var doublePressKeyPicker: some View {
        Picker("Modifier key:", selection: Binding(
            get: { doublePressKeyRaw },
            set: { doublePressKeyRaw = $0 }
        )) {
            ForEach(DoublePressKey.allCases, id: \.rawValue) { key in
                Text(key.displayName).tag(key.rawValue)
            }
        }
        .pickerStyle(.menu)
        .controlSize(.small)
    }

    private var keyboardShortcutsSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("KEYBOARD SHORTCUTS")
                .sectionLabel()

            VStack(spacing: Spacing.md) {
                // MARK: Voice to Note
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    if capsLockMode == .voiceToNote {
                        HStack {
                            Text("Voice to Note")
                                .foregroundStyle(.secondary)
                            Spacer()
                            capsLockBadge
                        }
                    } else {
                        KeyboardShortcuts.Recorder("Voice to Note", name: .toggleRecording)
                    }
                    Text("Press to start/stop. Transcription is processed by AI and stored as a note.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)

                    Toggle("Use Caps Lock key", isOn: Binding(
                        get: { capsLockMode == .voiceToNote },
                        set: { capsLockModeRaw = $0 ? CapsLockMode.voiceToNote.rawValue : CapsLockMode.off.rawValue }
                    ))
                    .toggleStyle(.switch)
                    .controlSize(.small)

                    if capsLockMode == .voiceToNote {
                        capsLockInfoBox
                    }

                    Toggle("Use double-press modifier key", isOn: Binding(
                        get: { doublePressAction == .voiceToNote },
                        set: { doublePressActionRaw = $0 ? DoublePressAction.voiceToNote.rawValue : DoublePressAction.off.rawValue }
                    ))
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .disabled(capsLockMode == .voiceToNote)

                    if doublePressAction == .voiceToNote {
                        doublePressKeyPicker
                    }

                    if capsLockMode != .voiceToNote {
                        ShortcutConflictView(
                            conflicts: toggleRecordingConflicts,
                            onDisableSystemShortcut: { id in
                                pendingDisableID = id
                                pendingDisableName = SystemShortcutNames.name(forID: id)
                                showDisableConfirmation = true
                            }
                        )
                    }
                }

                Divider()

                // MARK: Transcribe
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    if capsLockMode == .transcribe {
                        HStack {
                            Text("Transcribe")
                                .foregroundStyle(.secondary)
                            Spacer()
                            capsLockBadge
                        }
                    } else {
                        KeyboardShortcuts.Recorder("Transcribe", name: .dictationMode)
                    }
                    Text("Hold to dictate. On release, text is pasted at your cursor. No AI processing.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)

                    Toggle("Use Caps Lock key", isOn: Binding(
                        get: { capsLockMode == .transcribe },
                        set: { capsLockModeRaw = $0 ? CapsLockMode.transcribe.rawValue : CapsLockMode.off.rawValue }
                    ))
                    .toggleStyle(.switch)
                    .controlSize(.small)

                    if capsLockMode == .transcribe {
                        capsLockInfoBox
                    }

                    Toggle("Use double-press modifier key", isOn: Binding(
                        get: { doublePressAction == .transcribe },
                        set: { doublePressActionRaw = $0 ? DoublePressAction.transcribe.rawValue : DoublePressAction.off.rawValue }
                    ))
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .disabled(capsLockMode == .transcribe)

                    if doublePressAction == .transcribe {
                        doublePressKeyPicker
                        Text("Double-press to start, double-press again to stop and paste.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }

                    if capsLockMode != .transcribe {
                        ShortcutConflictView(
                            conflicts: dictationModeConflicts,
                            onDisableSystemShortcut: { id in
                                pendingDisableID = id
                                pendingDisableName = SystemShortcutNames.name(forID: id)
                                showDisableConfirmation = true
                            }
                        )
                    }
                }

                Divider()

                // MARK: Accessibility
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    HStack {
                        Text("Accessibility")
                            .foregroundStyle(.secondary)
                        Spacer()
                        HStack(spacing: 6) {
                            Circle()
                                .fill(isAccessibilityGranted ? .green : .orange)
                                .frame(width: 8, height: 8)
                            Text(isAccessibilityGranted ? "Granted" : "Not Granted")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Text(isAccessibilityGranted
                         ? "Transcribe will paste directly at your cursor."
                         : "Without Accessibility, Transcribe copies text to your clipboard instead of pasting at the cursor. Caps Lock shortcut also requires it.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)

                    if !isAccessibilityGranted {
                        HStack {
                            Spacer()
                            Button("Grant Accessibility Permission") {
                                ClipboardPasteService.requestAccessibilityIfNeeded()
                                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                                    isAccessibilityGranted = ClipboardPasteService.isAccessibilityTrusted
                                }
                            }
                            .controlSize(.small)
                            Button("Open Settings") {
                                ClipboardPasteService.openAccessibilitySettings()
                                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                                    isAccessibilityGranted = ClipboardPasteService.isAccessibilityTrusted
                                }
                            }
                            .controlSize(.small)
                        }
                    }
                }
            }
            .padding(Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Radius.md)
                    .fill(AppColors.surface)
            )
            .modifier(Elevation.card(colorScheme))
            .onAppear {
                checkAllConflicts()
                isAccessibilityGranted = ClipboardPasteService.isAccessibilityTrusted
            }
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                isAccessibilityGranted = ClipboardPasteService.isAccessibilityTrusted
            }
            .onReceive(NotificationCenter.default.publisher(for: Notification.Name("KeyboardShortcuts_shortcutByNameDidChange"))) { _ in
                checkAllConflicts()
            }
            .alert("Disable System Shortcut?", isPresented: $showDisableConfirmation) {
                Button("Cancel", role: .cancel) {}
                Button("Disable", role: .destructive) {
                    if let id = pendingDisableID {
                        _ = conflictDetector.disableSystemShortcut(id: id)
                        checkAllConflicts()
                    }
                }
            } message: {
                Text("This will disable \"\(pendingDisableName)\" in macOS system settings. You may need to log out and back in for the change to take full effect.")
            }
        }
    }

    private func checkAllConflicts() {
        if let shortcut = KeyboardShortcuts.getShortcut(for: .toggleRecording) {
            toggleRecordingConflicts = conflictDetector.detectConflicts(for: shortcut, excludingName: .toggleRecording)
        } else {
            toggleRecordingConflicts = []
        }
        if let shortcut = KeyboardShortcuts.getShortcut(for: .dictationMode) {
            dictationModeConflicts = conflictDetector.detectConflicts(for: shortcut, excludingName: .dictationMode)
        } else {
            dictationModeConflicts = []
        }
    }

    // MARK: - AI Model

    private var aiModelSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("AI MODEL")
                .sectionLabel()

            VStack(spacing: Spacing.sm) {
                ForEach(AIModelVariant.allCases) { variant in
                    aiModelCard(for: variant)
                }
            }

            Text("This model handles text analysis. Speech recognition uses the Whisper model above.")
                .font(.caption2)
                .foregroundStyle(.quaternary)
        }
    }

    private func aiModelCard(for variant: AIModelVariant) -> some View {
        let isActive = variant == viewModel.selectedAIVariant
        let modelState = isActive ? viewModel.mlxService.modelState : .notDownloaded

        return HStack(spacing: Spacing.md) {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                HStack(spacing: Spacing.sm) {
                    Text(variant.displayName)
                        .font(.headline)
                        .fontWeight(.medium)

                    if isActive {
                        Text("Active")
                            .pillStyle()
                    }

                    if variant.isDefault && !isActive {
                        Text("Default")
                            .font(.system(size: 9))
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Color.accentColor.opacity(0.15))
                            .clipShape(Capsule())
                    }

                    if isActive, case .ready = modelState {
                        Circle()
                            .fill(.green)
                            .frame(width: 6, height: 6)
                    }
                }

                VStack(spacing: 3) {
                    ComparisonBar(label: "Quality", value: variant.qualityScore, color: .green)
                    ComparisonBar(label: "Speed", value: variant.speedScore, color: .blue)
                    ComparisonBar(label: "Size", value: variant.normalizedSize, color: .orange, suffix: variant.storageSize)
                }

                if isActive, case .downloading(let progress) = modelState {
                    ProgressView(value: progress)
                        .tint(.accentColor)
                }
            }

            Spacer(minLength: 0)

            if isActive {
                switch modelState {
                case .notDownloaded:
                    Button {
                        viewModel.downloadModel()
                    } label: {
                        Image(systemName: "arrow.down.circle")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help("Download model")

                case .downloading:
                    ProgressView()
                        .controlSize(.small)

                case .ready:
                    EmptyView()

                case .error:
                    Button {
                        viewModel.downloadModel()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.title3)
                            .foregroundStyle(.red)
                    }
                    .buttonStyle(.plain)
                    .help("Retry download")
                }
            }
        }
        .cardStyle(isSelected: isActive)
        .contentShape(Rectangle())
        .onTapGesture {
            if !isActive {
                viewModel.selectedAIVariant = variant
            }
        }
    }

    // MARK: - Data

    private var dataSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("DATA")
                .sectionLabel()

            VStack(spacing: Spacing.md) {
                HStack {
                    Text("Database")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("~/Library/Application Support/EchoScribe/db.sqlite")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .textSelection(.enabled)
                }

                Divider()

                HStack(spacing: Spacing.sm) {
                    Spacer()
                    Button("Export as JSON") {
                        viewModel.exportNotesAsJSON()
                    }
                    .controlSize(.small)

                    Button("Export as Markdown") {
                        viewModel.exportNotesAsMarkdown()
                    }
                    .controlSize(.small)
                }
            }
            .padding(Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Radius.md)
                    .fill(AppColors.surface)
            )
            .modifier(Elevation.card(colorScheme))
        }
    }

    // MARK: - Uninstall

    private var uninstallSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("DANGER ZONE")
                .sectionLabel()

            VStack(spacing: Spacing.md) {
                HStack {
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        Text("Uninstall Echo Scribe")
                            .foregroundStyle(.primary)
                        Text("Remove all data, downloaded models, and preferences.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    Spacer()
                    Button("Uninstall...") {
                        showUninstallAlert = true
                    }
                    .controlSize(.small)
                    .foregroundStyle(.red)
                }
            }
            .padding(Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Radius.md)
                    .strokeBorder(.red.opacity(0.3), lineWidth: 1)
                    .background(
                        RoundedRectangle(cornerRadius: Radius.md)
                            .fill(AppColors.surface)
                    )
            )
            .modifier(Elevation.card(colorScheme))
        }
    }

}

// MARK: - Comparison Bar

private struct ComparisonBar: View {
    let label: String
    let value: Double
    let color: Color
    var suffix: String? = nil

    var body: some View {
        HStack(spacing: Spacing.xs) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .frame(width: 55, alignment: .leading)

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(color.opacity(0.12))
                    RoundedRectangle(cornerRadius: 2)
                        .fill(color)
                        .frame(width: geo.size.width * min(value, 1.0))
                }
            }
            .frame(height: 5)

            if let suffix {
                Text(suffix)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .frame(width: 50, alignment: .trailing)
            }
        }
    }
}
