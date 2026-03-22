import SwiftUI
import KeyboardShortcuts

struct SettingsView: View {
    @Bindable var viewModel: SettingsViewModel
    @Bindable var menuBarManager: MenuBarManager

    var body: some View {
        TabView {
            speechTab
                .tabItem {
                    Label("Speech", systemImage: "waveform")
                }

            aiModelTab
                .tabItem {
                    Label("AI Model", systemImage: "cpu")
                }

            recordingTab
                .tabItem {
                    Label("Recording", systemImage: "mic")
                }

            dataTab
                .tabItem {
                    Label("Data", systemImage: "externaldrive")
                }
        }
        .frame(width: 500, height: 350)
    }

    // MARK: - Speech Tab

    private var speechTab: some View {
        Form {
            Section {
                Picker("Engine", selection: $viewModel.selectedEngine) {
                    ForEach(SpeechEngine.allCases) { engine in
                        Text(engine.rawValue).tag(engine)
                    }
                }
            }

            if viewModel.selectedEngine == .whisper {
                Section("Whisper Model") {
                    LabeledContent("Model") {
                        Text(viewModel.whisperService.selectedModel)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }

                    LabeledContent("Status") {
                        HStack(spacing: 6) {
                            whisperStatusIndicator
                            Text(viewModel.whisperStatusText)
                                .font(.caption)
                        }
                    }

                    if viewModel.isWhisperDownloading {
                        ProgressView(value: viewModel.whisperDownloadProgress)
                    }

                    if case .notDownloaded = viewModel.whisperService.modelState {
                        Button("Download Model") {
                            viewModel.downloadWhisperModel()
                        }
                        .buttonStyle(.borderedProminent)
                    }

                    if case .error = viewModel.whisperService.modelState {
                        Button("Retry Download") {
                            viewModel.downloadWhisperModel()
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    // MARK: - AI Model Tab

    private var aiModelTab: some View {
        Form {
            Section {
                LabeledContent("Model") {
                    Text(viewModel.mlxService.modelName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }

                LabeledContent("Status") {
                    HStack(spacing: 6) {
                        mlxStatusIndicator
                        Text(viewModel.statusText)
                            .font(.caption)
                    }
                }

                if viewModel.isDownloading {
                    ProgressView(value: viewModel.downloadProgress)
                }

                if case .notDownloaded = viewModel.mlxService.modelState {
                    Button("Download Model") {
                        viewModel.downloadModel()
                    }
                    .buttonStyle(.borderedProminent)
                }

                if case .error = viewModel.mlxService.modelState {
                    Button("Retry Download") {
                        viewModel.downloadModel()
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    // MARK: - Recording Tab

    private var recordingTab: some View {
        Form {
            Section {
                Picker("Mode", selection: $viewModel.recordingMode) {
                    ForEach(RecordingMode.allCases) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
            }

            Section("Global Hotkey") {
                KeyboardShortcuts.Recorder("Toggle Recording", name: .toggleRecording)

                Text("Works system-wide when the app is running. May require Accessibility permission.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            Section("Menu Bar") {
                Toggle("Show in menu bar", isOn: $menuBarManager.isMenuBarEnabled)

                Text("Quick access to recording from the menu bar icon.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    // MARK: - Data Tab

    private var dataTab: some View {
        Form {
            Section {
                LabeledContent("Database") {
                    Text("~/Library/Application Support/EchoScribe/db.sqlite")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }

            Section("Export") {
                Button("Export as JSON") {
                    viewModel.exportNotesAsJSON()
                }

                Button("Export as Markdown") {
                    viewModel.exportNotesAsMarkdown()
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    // MARK: - Status Indicators

    @ViewBuilder
    private var mlxStatusIndicator: some View {
        switch viewModel.mlxService.modelState {
        case .notDownloaded:
            Circle().fill(.gray).frame(width: 8, height: 8)
        case .downloading:
            Circle().fill(.orange).frame(width: 8, height: 8)
        case .ready:
            Circle().fill(.green).frame(width: 8, height: 8)
        case .error:
            Circle().fill(.red).frame(width: 8, height: 8)
        }
    }

    @ViewBuilder
    private var whisperStatusIndicator: some View {
        switch viewModel.whisperService.modelState {
        case .notDownloaded:
            Circle().fill(.gray).frame(width: 8, height: 8)
        case .downloading:
            Circle().fill(.orange).frame(width: 8, height: 8)
        case .ready:
            Circle().fill(.green).frame(width: 8, height: 8)
        case .error:
            Circle().fill(.red).frame(width: 8, height: 8)
        }
    }
}
