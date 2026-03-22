import SwiftUI
import CoreData

struct ContentView: View {
    @State private var selectedProjectId: String?
    @State private var selectedSmartFilter: SmartFilter = .all
    @State private var allTags: [CDTag] = []
    @State private var selectedNoteId: UUID?
    @State private var searchText = ""

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
        ZStack(alignment: .leading) {
            mainContent

            if appState.isSidebarVisible {
                sidebarOverlay
            }

            if let noteDetail = selectedNoteDetail {
                detailOverlay(noteDetail)
            }
        }
        .onExitCommand {
            if selectedNoteId != nil {
                withAnimation(AppAnimation.gentle) {
                    selectedNoteId = nil
                }
            } else if appState.isSidebarVisible {
                withAnimation(AppAnimation.gentle) {
                    appState.isSidebarVisible = false
                }
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .navigation) {
                Button {
                    withAnimation(AppAnimation.gentle) {
                        appState.isSidebarVisible.toggle()
                    }
                } label: {
                    Image(systemName: "sidebar.left")
                        .foregroundStyle(.secondary)
                }
                .help("Toggle sidebar")
            }

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
        .onChange(of: selectedProjectId) { _, newValue in
            feedViewModel.selectedProjectId = newValue
            feedViewModel.startObservation()
        }
        .onChange(of: selectedSmartFilter) { _, newFilter in
            applySmartFilter(newFilter)
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
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Populated State

    private var populatedView: some View {
        VStack(spacing: Spacing.lg) {
            VStack(spacing: Spacing.md) {
                recordButton
                    .padding(.top, Spacing.md)

                if appState.isRecordingInline {
                    inlineRecordingView
                }

                searchField
            }

            HStack {
                ContextSummaryView(
                    feedViewModel: feedViewModel,
                    onTapTasks: {
                        selectedSmartFilter = .todaysTasks
                        selectedProjectId = nil
                    },
                    onTapRecent: {
                        selectedSmartFilter = .recent
                        selectedProjectId = nil
                    }
                )

                Spacer()

                viewModePicker
            }

            contentView
        }
    }

    // MARK: - Record Button

    private var recordButton: some View {
        HStack(spacing: Spacing.xs) {
            Button {
                recordingViewModel.toggleRecording()
            } label: {
                HStack(spacing: Spacing.sm) {
                    Image(systemName: recordingViewModel.isRecording ? "stop.fill" : "mic.fill")
                        .font(.title3)
                    Text(recordingViewModel.isRecording ? "Stop Recording" : "Record")
                        .font(.body)
                        .fontWeight(.semibold)
                }
                .foregroundStyle(.white)
                .padding(.horizontal, Spacing.xl)
                .padding(.vertical, Spacing.md)
                .background(
                    Capsule()
                        .fill(recordingViewModel.isRecording ? Color.red : Color.accentColor)
                )
                .modifier(FloatElevation(colorScheme: colorScheme))
            }
            .buttonStyle(.plain)
            .keyboardShortcut("r", modifiers: [.command])

            if !recordingViewModel.isRecording {
                microphoneMenu
            }
        }
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
            Image(systemName: "chevron.down")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(width: 20, height: 20)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Select microphone")
    }

    @Environment(\.colorScheme) private var colorScheme

    // MARK: - Inline Recording

    private var inlineRecordingView: some View {
        VStack(spacing: Spacing.md) {
            WaveformView(level: recordingViewModel.audioLevel)
                .frame(height: 40)

            if !recordingViewModel.liveTranscript.isEmpty {
                Text(recordingViewModel.liveTranscript)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Spacing.md)
                    .background(
                        RoundedRectangle(cornerRadius: Radius.md)
                            .fill(AppColors.surface)
                    )
            } else {
                Text("Listening...")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
            }

            if let error = recordingViewModel.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(Spacing.md)
        .background(
            RoundedRectangle(cornerRadius: Radius.lg)
                .fill(AppColors.surface)
        )
        .gentleAppear()
    }

    // MARK: - Search Field

    private var searchField: some View {
        HStack(spacing: Spacing.sm) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.tertiary)
            TextField("Search your notes...", text: $searchText)
                .textFieldStyle(.plain)
        }
        .padding(Spacing.sm + 2)
        .background(
            RoundedRectangle(cornerRadius: Radius.md)
                .fill(AppColors.surface)
        )
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
            ProjectGroupView(
                feedViewModel: feedViewModel,
                projects: projectsViewModel.projects
            )
        case .settings:
            EmptyView()
        }
    }

    // MARK: - Sidebar Overlay

    private var sidebarOverlay: some View {
        HStack(spacing: 0) {
            SidebarView(
                projectsViewModel: projectsViewModel,
                selectedProjectId: $selectedProjectId,
                selectedSmartFilter: $selectedSmartFilter
            )
            .frame(width: 240)
            .background(.regularMaterial)
            .clipShape(RoundedRectangle(cornerRadius: Radius.lg))
            .modifier(FloatElevation(colorScheme: colorScheme))
            .padding(Spacing.sm)
            .transition(.move(edge: .leading).combined(with: .opacity))

            Color.black.opacity(0.001)
                .onTapGesture {
                    withAnimation(AppAnimation.gentle) {
                        appState.isSidebarVisible = false
                    }
                }
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
                    let ctx = noteDetail.note.managedObjectContext ?? context
                    selectedNoteId = nil
                    ctx.delete(noteDetail.note)
                    try? ctx.save()
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

    private func applySmartFilter(_ filter: SmartFilter) {
        feedViewModel.clearFilters()
        switch filter {
        case .all:
            break
        case .todaysTasks:
            let today = Calendar.current.startOfDay(for: Date())
            let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: today)!
            feedViewModel.dateRange = today...tomorrow
            feedViewModel.startObservation()
        case .recent:
            let weekAgo = Calendar.current.date(byAdding: .day, value: -7, to: Date())!
            feedViewModel.dateRange = weekAgo...Date()
            feedViewModel.startObservation()
        case .unprocessed:
            feedViewModel.startObservation()
        }
    }

    @Environment(\.managedObjectContext) private var context

    private func loadTags() {
        let request: NSFetchRequest<CDTag> = CDTag.fetchRequest()
        request.sortDescriptors = [NSSortDescriptor(key: "name", ascending: true)]
        allTags = (try? context.fetch(request)) ?? []
    }
}
