import SwiftUI
import CoreData

struct ContentView: View {
    @State private var allTags: [CDTag] = []
    @State private var selectedNoteId: UUID?
    @State private var searchText = ""
    @State private var showProjectsSidebar = false

    @Bindable var feedViewModel: FeedViewModel
    @Bindable var recordingViewModel: RecordingViewModel
    @Bindable var projectsViewModel: ProjectsViewModel
    @Bindable var settingsViewModel: SettingsViewModel
    @Bindable var appState: AppState
    @Bindable var audioDeviceManager: AudioDeviceManager

    private var selectedNoteDetail: NoteWithDetails? {
        guard let selectedNoteId else { return nil }
        return feedViewModel.notes.first { $0.id == selectedNoteId }
    }

    var body: some View {
        HStack(spacing: 0) {
            if showProjectsSidebar {
                ProjectsSidebarView(
                    projectsViewModel: projectsViewModel,
                    feedViewModel: feedViewModel,
                    appState: appState
                )
                .frame(width: 220)
                .transition(.move(edge: .leading).combined(with: .opacity))

                Divider()
            }

            ZStack(alignment: .leading) {
                mainContent

                if let noteDetail = selectedNoteDetail {
                    detailOverlay(noteDetail)
                }
            }
        }
        .animation(AppAnimation.gentle, value: showProjectsSidebar)
        .onExitCommand {
            if selectedNoteId != nil {
                withAnimation(AppAnimation.gentle) {
                    selectedNoteId = nil
                }
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    if appState.currentViewMode == .settings {
                        appState.currentViewMode = .feed
                    } else {
                        appState.currentViewMode = .settings
                    }
                } label: {
                    Image(systemName: appState.currentViewMode == .settings ? "gear.circle.fill" : "gear")
                        .foregroundStyle(appState.currentViewMode == .settings ? .primary : .secondary)
                }
                .help(appState.currentViewMode == .settings ? "Close Settings" : "Settings")
            }
        }
        .onChange(of: searchText) { _, newText in
            feedViewModel.searchText = newText
            feedViewModel.startObservation()
        }
        .onChange(of: recordingViewModel.isRecording) { _, isRecording in
            withAnimation(AppAnimation.gentle) {
                appState.isRecordingInline = isRecording
            }
        }
        .onChange(of: recordingViewModel.isPreparing) { _, isPreparing in
            withAnimation(AppAnimation.gentle) {
                appState.isRecordingInline = isPreparing || recordingViewModel.isRecording || recordingViewModel.isTranscribing
            }
        }
        .onChange(of: recordingViewModel.isTranscribing) { _, isTranscribing in
            withAnimation(AppAnimation.gentle) {
                appState.isRecordingInline = isTranscribing || recordingViewModel.isRecording || recordingViewModel.isPreparing
            }
        }
        .task {
            loadTags()
        }
        .frame(minWidth: 600, minHeight: 500)
    }

    // MARK: - Main Content

    private var mainContent: some View {
        ScrollView {
            VStack(spacing: 0) {
                if appState.currentViewMode == .settings {
                    SettingsView(viewModel: settingsViewModel, audioDeviceManager: audioDeviceManager) {
                        appState.currentViewMode = .feed
                    }
                    .pageContainer()
                } else {
                    populatedView
                        .pageContainer()
                }
            }
        }
        .background(.ultraThinMaterial)
    }

    // MARK: - Populated State

    private var populatedView: some View {
        VStack(spacing: Spacing.lg) {
            recordingArea
                .padding(.top, Spacing.md)

            toolbarRow

            contentView
        }
    }

    // MARK: - Recording Area

    private var recordingArea: some View {
        HStack(spacing: Spacing.md) {
            // Circle mic/stop button
            Button {
                recordingViewModel.toggleRecording()
            } label: {
                Group {
                    if recordingViewModel.isPreparing {
                        ProgressView()
                            .controlSize(.small)
                            .tint(.white)
                    } else {
                        Image(systemName: recordingViewModel.isRecording ? "stop.fill" : "mic.fill")
                            .font(.title3)
                    }
                }
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(
                    Circle()
                        .fill(recordingViewModel.isRecording ? Color.red : Color.accentColor)
                )
            }
            .buttonStyle(.plain)
            .disabled(recordingViewModel.isPreparing)
            .keyboardShortcut("r", modifiers: [.command])

            if recordingViewModel.isRecording || recordingViewModel.isPreparing || recordingViewModel.isTranscribing {
                // Recording/transcribing state
                if recordingViewModel.isTranscribing {
                    ProgressView()
                        .controlSize(.small)
                    Text("Transcribing...")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if recordingViewModel.isPreparing {
                    Text("Preparing...")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    WaveformView(level: recordingViewModel.audioLevel)
                        .frame(width: 120, height: 32)

                    if !recordingViewModel.liveTranscript.isEmpty {
                        Text(recordingViewModel.liveTranscript)
                            .font(.body)
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Text("Listening...")
                            .font(.subheadline)
                            .foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                if let error = recordingViewModel.errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            } else {
                // Idle state: spacer + mic selection
                Spacer()
                microphoneMenu
            }
        }
        .padding(Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: Radius.lg)
                .fill(AppColors.surface)
        )
        .animation(AppAnimation.gentle, value: recordingViewModel.isRecording)
        .animation(AppAnimation.gentle, value: recordingViewModel.isPreparing)
        .animation(AppAnimation.gentle, value: recordingViewModel.isTranscribing)
    }

    private var microphoneMenu: some View {
        Menu {
            ForEach(audioDeviceManager.availableDevices) { device in
                Button {
                    audioDeviceManager.selectDevice(device)
                } label: {
                    if device.uid == audioDeviceManager.selectedDevice?.uid {
                        Label(device.name, systemImage: "checkmark")
                    } else {
                        Text(device.name)
                    }
                }
            }
        } label: {
            Text(audioDeviceManager.selectedDevice?.name ?? "Microphone")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Select microphone")
    }

    @Environment(\.colorScheme) private var colorScheme

    // MARK: - Toolbar Row (Search + Notes Count + Projects Pill + View Picker)

    private var toolbarRow: some View {
        HStack(spacing: Spacing.sm) {
            // Search field
            HStack(spacing: Spacing.sm) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.tertiary)
                TextField("Search your notes...", text: $searchText)
                    .textFieldStyle(.plain)
            }
            .padding(Spacing.sm + 2)
            .background(
                RoundedRectangle(cornerRadius: Radius.md)
                    .fill(AppColors.surfaceAlt)
            )

            // Notes count
            HStack(spacing: Spacing.xs) {
                Image(systemName: "doc.text")
                    .font(.caption2)
                Text("\(feedViewModel.notes.count) note\(feedViewModel.notes.count == 1 ? "" : "s")")
                    .font(.caption)
            }
            .foregroundStyle(.secondary)
            .fixedSize()

            // Projects pill
            Button {
                withAnimation(AppAnimation.gentle) {
                    showProjectsSidebar.toggle()
                }
            } label: {
                Text("Projects")
                    .font(.caption)
                    .fontWeight(.medium)
                    .padding(.horizontal, Spacing.sm + 2)
                    .padding(.vertical, Spacing.xs + 1)
                    .background(
                        Capsule()
                            .fill(showProjectsSidebar ? Color.accentColor.opacity(0.15) : Color.clear)
                    )
                    .foregroundStyle(showProjectsSidebar ? Color.accentColor : .secondary)
            }
            .buttonStyle(.plain)

            // View mode picker
            viewModePicker
        }
    }

    // MARK: - View Mode Picker

    private var viewModePicker: some View {
        HStack(spacing: 2) {
            ForEach(ViewMode.navigationModes) { mode in
                viewModeButton(mode)
            }
        }
    }

    private func viewModeButton(_ mode: ViewMode) -> some View {
        Button {
            appState.currentViewMode = mode
        } label: {
            Label(mode.rawValue, systemImage: mode.icon)
                .labelStyle(.iconOnly)
                .font(.caption)
        }
        .buttonStyle(.plain)
        .ghostButton(isActive: appState.currentViewMode == mode)
        .help(mode.rawValue)
    }

    // MARK: - Content View Switcher

    @ViewBuilder
    private var contentView: some View {
        switch appState.currentViewMode {
        case .feed:
            FeedView(feedViewModel: feedViewModel, selectedNoteId: $selectedNoteId)
        case .kanban:
            KanbanView(
                feedViewModel: feedViewModel,
                projects: projectsViewModel.projects
            )
        case .calendar:
            CalendarView(feedViewModel: feedViewModel)
        case .projectGroups:
            FeedView(feedViewModel: feedViewModel, selectedNoteId: $selectedNoteId)
        case .settings:
            EmptyView()
        }
    }

    // MARK: - Detail Overlay

    private func detailOverlay(_ noteDetail: NoteWithDetails) -> some View {
        HStack(spacing: 0) {
            Color.black.opacity(0.001)
                .onTapGesture {
                    withAnimation(AppAnimation.gentle) {
                        selectedNoteId = nil
                    }
                }
            NoteDetailView(
                note: noteDetail.note,
                projects: projectsViewModel.projects.map(\.project),
                onDismiss: { selectedNoteId = nil },
                onDelete: {
                    selectedNoteId = nil
                    feedViewModel.deleteNote(noteDetail)
                }
            )
            .frame(width: 400)
            .background(.regularMaterial)
            .clipShape(RoundedRectangle(cornerRadius: Radius.lg))
            .modifier(FloatElevation(colorScheme: colorScheme))
            .padding(Spacing.sm)
            .transition(.move(edge: .trailing).combined(with: .opacity))
        }
    }

    // MARK: - Helpers

    @Environment(\.managedObjectContext) private var context

    private func loadTags() {
        let request: NSFetchRequest<CDTag> = CDTag.fetchRequest()
        request.sortDescriptors = [NSSortDescriptor(key: "name", ascending: true)]
        allTags = (try? context.fetch(request)) ?? []
    }
}
