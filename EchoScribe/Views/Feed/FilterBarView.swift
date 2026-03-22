import SwiftUI

struct FilterBarView: View {
    @Bindable var feedViewModel: FeedViewModel
    var projects: [ProjectWithCount] = []
    var allTags: [Tag] = []

    @State private var showProjectFilter = false
    @State private var showTagFilter = false
    @State private var showDateFilter = false
    @State private var startDate = Calendar.current.date(byAdding: .month, value: -1, to: Date()) ?? Date()
    @State private var endDate = Date()

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)

                TextField("Search notes...", text: Binding(
                    get: { feedViewModel.searchText },
                    set: { newValue in
                        feedViewModel.searchText = newValue
                        feedViewModel.startObservation()
                    }
                ))
                .textFieldStyle(.plain)

                Spacer()

                // Filter buttons
                filterButton("Project", icon: "folder", isActive: feedViewModel.selectedProjectId != nil) {
                    showProjectFilter.toggle()
                }
                .popover(isPresented: $showProjectFilter) {
                    projectFilterPopover
                }

                filterButton("Tags", icon: "tag", isActive: !feedViewModel.selectedTags.isEmpty) {
                    showTagFilter.toggle()
                }
                .popover(isPresented: $showTagFilter) {
                    tagFilterPopover
                }

                filterButton("Date", icon: "calendar", isActive: feedViewModel.dateRange != nil) {
                    showDateFilter.toggle()
                }
                .popover(isPresented: $showDateFilter) {
                    dateFilterPopover
                }

                if hasActiveFilters {
                    Button {
                        feedViewModel.clearFilters()
                    } label: {
                        Label("Clear", systemImage: "xmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.bar)

            // Active filter chips
            if hasActiveFilters {
                activeFilterChips
            }
        }
    }

    private func filterButton(_ label: String, icon: String, isActive: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(label, systemImage: icon)
                .font(.caption)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(isActive ? Color.accentColor.opacity(0.15) : Color.clear, in: Capsule())
                .foregroundStyle(isActive ? .accent : .secondary)
        }
        .buttonStyle(.plain)
    }

    private var projectFilterPopover: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Filter by Project").font(.headline).padding(.bottom, 4)

            Button {
                feedViewModel.selectedProjectId = nil
                feedViewModel.startObservation()
                showProjectFilter = false
            } label: {
                HStack {
                    Text("All Projects")
                    Spacer()
                    if feedViewModel.selectedProjectId == nil {
                        Image(systemName: "checkmark")
                    }
                }
            }
            .buttonStyle(.plain)

            Divider()

            ForEach(projects, id: \.project.id) { projectWithCount in
                Button {
                    feedViewModel.selectedProjectId = projectWithCount.project.id
                    feedViewModel.startObservation()
                    showProjectFilter = false
                } label: {
                    HStack {
                        Circle()
                            .fill(Color(hex: projectWithCount.project.color) ?? .blue)
                            .frame(width: 8, height: 8)
                        Text(projectWithCount.project.name)
                        Spacer()
                        Text("\(projectWithCount.noteCount)")
                            .foregroundStyle(.secondary)
                            .font(.caption)
                        if feedViewModel.selectedProjectId == projectWithCount.project.id {
                            Image(systemName: "checkmark")
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .padding()
        .frame(width: 220)
    }

    private var tagFilterPopover: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Filter by Tags").font(.headline).padding(.bottom, 4)

            if allTags.isEmpty {
                Text("No tags yet")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(allTags) { tag in
                    Button {
                        if feedViewModel.selectedTags.contains(tag.id) {
                            feedViewModel.selectedTags.remove(tag.id)
                        } else {
                            feedViewModel.selectedTags.insert(tag.id)
                        }
                        feedViewModel.startObservation()
                    } label: {
                        HStack {
                            Text("#\(tag.name)")
                            Spacer()
                            if feedViewModel.selectedTags.contains(tag.id) {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(.accentColor)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }

            if !feedViewModel.selectedTags.isEmpty {
                Divider()
                Button("Clear Tags") {
                    feedViewModel.selectedTags.removeAll()
                    feedViewModel.startObservation()
                }
                .font(.caption)
            }
        }
        .padding()
        .frame(width: 200)
    }

    private var dateFilterPopover: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Filter by Date").font(.headline)

            DatePicker("From", selection: $startDate, displayedComponents: .date)
            DatePicker("To", selection: $endDate, displayedComponents: .date)

            HStack {
                Button("Clear") {
                    feedViewModel.dateRange = nil
                    feedViewModel.startObservation()
                    showDateFilter = false
                }

                Spacer()

                Button("Apply") {
                    feedViewModel.dateRange = startDate...endDate
                    feedViewModel.startObservation()
                    showDateFilter = false
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .frame(width: 260)
    }

    private var activeFilterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                if let projectId = feedViewModel.selectedProjectId,
                   let project = projects.first(where: { $0.project.id == projectId }) {
                    filterChip(label: project.project.name, icon: "folder") {
                        feedViewModel.selectedProjectId = nil
                        feedViewModel.startObservation()
                    }
                }

                ForEach(allTags.filter { feedViewModel.selectedTags.contains($0.id) }) { tag in
                    filterChip(label: "#\(tag.name)", icon: "tag") {
                        feedViewModel.selectedTags.remove(tag.id)
                        feedViewModel.startObservation()
                    }
                }

                if feedViewModel.dateRange != nil {
                    filterChip(label: "Date range", icon: "calendar") {
                        feedViewModel.dateRange = nil
                        feedViewModel.startObservation()
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
        .background(.bar.opacity(0.5))
    }

    private func filterChip(label: String, icon: String, onRemove: @escaping () -> Void) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.caption2)
            Text(label)
                .font(.caption)
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.caption2)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.accentColor.opacity(0.1), in: Capsule())
        .foregroundStyle(.accentColor)
    }

    private var hasActiveFilters: Bool {
        !feedViewModel.searchText.isEmpty ||
        feedViewModel.selectedProjectId != nil ||
        !feedViewModel.selectedTags.isEmpty ||
        feedViewModel.dateRange != nil
    }
}
