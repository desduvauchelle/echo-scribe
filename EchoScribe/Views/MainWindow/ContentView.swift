import SwiftUI

struct ContentView: View {
    @State private var selectedProjectId: String?
    @State private var selectedSmartFilter: SmartFilter = .all
    @State private var showRecordingOverlay = false
    @State private var allTags: [Tag] = []
    @State private var selectedNoteId: String?

    @Bindable var feedViewModel: FeedViewModel
    @Bindable var recordingViewModel: RecordingViewModel
    @Bindable var projectsViewModel: ProjectsViewModel
    @Bindable var appState: AppState

    private var selectedNoteDetail: NoteWithDetails? {
        guard let selectedNoteId else { return nil }
        return feedViewModel.notes.first { $0.note.id == selectedNoteId }
    }

    var body: some View {
        NavigationSplitView {
            SidebarView(
                projectsViewModel: projectsViewModel,
                selectedProjectId: $selectedProjectId,
                selectedSmartFilter: $selectedSmartFilter
            )
        } detail: {
            HSplitView {
                VStack(spacing: 0) {
                    HStack(spacing: 0) {
                        viewModePicker
                        Spacer()
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.bar)

                    FilterBarView(
                        feedViewModel: feedViewModel,
                        projects: projectsViewModel.projects,
                        allTags: allTags
                    )

                    detailView
                }
                .frame(minWidth: 400)

                if let noteDetail = selectedNoteDetail {
                    NoteDetailView(
                        noteDetail: noteDetail,
                        projects: projectsViewModel.projects,
                        database: AppDatabase.shared,
                        onDismiss: { selectedNoteId = nil }
                    )
                    .frame(minWidth: 350, idealWidth: 400)
                    .transition(.move(edge: .trailing))
                }
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    recordingViewModel.toggleRecording()
                    showRecordingOverlay = recordingViewModel.isRecording
                } label: {
                    Label(
                        recordingViewModel.isRecording ? "Stop Recording" : "Record",
                        systemImage: recordingViewModel.isRecording ? "stop.circle.fill" : "mic.circle.fill"
                    )
                    .foregroundStyle(recordingViewModel.isRecording ? .red : .accentColor)
                    .font(.title2)
                }
                .keyboardShortcut("r", modifiers: [.command])
                .help(recordingViewModel.isRecording ? "Stop recording (Cmd+R)" : "Start recording (Cmd+R)")
            }
        }
        .sheet(isPresented: $showRecordingOverlay) {
            RecordingOverlayView(viewModel: recordingViewModel) {
                showRecordingOverlay = false
            }
        }
        .onChange(of: selectedProjectId) { _, newValue in
            feedViewModel.selectedProjectId = newValue
            feedViewModel.startObservation()
        }
        .onChange(of: selectedSmartFilter) { _, newFilter in
            applySmartFilter(newFilter)
        }
        .onChange(of: recordingViewModel.isRecording) { _, isRecording in
            if !isRecording {
                showRecordingOverlay = false
            }
        }
        .task {
            loadTags()
        }
        .frame(minWidth: 700, minHeight: 500)
    }

    private var viewModePicker: some View {
        HStack(spacing: 2) {
            ForEach(ViewMode.allCases) { mode in
                Button {
                    appState.currentViewMode = mode
                } label: {
                    Label(mode.rawValue, systemImage: mode.icon)
                        .labelStyle(.iconOnly)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(
                            appState.currentViewMode == mode ? Color.accentColor.opacity(0.15) : Color.clear,
                            in: RoundedRectangle(cornerRadius: 6)
                        )
                        .foregroundStyle(appState.currentViewMode == mode ? .accentColor : .secondary)
                }
                .buttonStyle(.plain)
                .help(mode.rawValue)
            }
        }
    }

    @ViewBuilder
    private var detailView: some View {
        switch appState.currentViewMode {
        case .feed:
            FeedView(feedViewModel: feedViewModel, selectedNoteId: $selectedNoteId)
        case .kanban:
            KanbanView(
                feedViewModel: feedViewModel,
                projects: projectsViewModel.projects,
                database: AppDatabase.shared
            )
        case .calendar:
            CalendarView(feedViewModel: feedViewModel)
        case .projectGroups:
            ProjectGroupView(
                feedViewModel: feedViewModel,
                projects: projectsViewModel.projects
            )
        }
    }

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

    private func loadTags() {
        do {
            allTags = try AppDatabase.shared.fetchAllTags()
        } catch {
            print("Failed to load tags: \(error)")
        }
    }
}
