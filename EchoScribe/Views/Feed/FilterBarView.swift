import SwiftUI

struct FilterBarView: View {
    @Bindable var feedViewModel: FeedViewModel
    var projects: [ProjectWithCount] = []
    var allTags: [CDTag] = []

    @State private var showProjectFilter = false
    @State private var showTagFilter = false
    @State private var showDateFilter = false
    @State private var startDate = Calendar.current.date(byAdding: .month, value: -1, to: Date()) ?? Date()
    @State private var endDate = Date()

    var body: some View {
        VStack(spacing: 0) {
            if hasActiveFilters {
                activeFilterChips
            }
        }
    }

    var filterButtons: some View {
        HStack(spacing: Spacing.xs) {
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
    }

    private func filterButton(_ label: String, icon: String, isActive: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(label, systemImage: icon)
                .font(.caption)
        }
        .buttonStyle(.plain)
        .ghostButton(isActive: isActive)
    }

    private var projectFilterPopover: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("Filter by Project").font(.headline).padding(.bottom, Spacing.xs)

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
                    feedViewModel.selectedProjectId = projectWithCount.project.id.uuidString
                    feedViewModel.startObservation()
                    showProjectFilter = false
                } label: {
                    HStack {
                        Circle()
                            .fill(Color(hex: projectWithCount.color) ?? .blue)
                            .frame(width: 8, height: 8)
                        Text(projectWithCount.name)
                        Spacer()
                        Text("\(projectWithCount.noteCount)")
                            .foregroundStyle(.secondary)
                            .font(.caption)
                        if feedViewModel.selectedProjectId == projectWithCount.project.id.uuidString {
                            Image(systemName: "checkmark")
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(Spacing.md)
        .frame(width: 220)
    }

    private var tagFilterPopover: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text("Filter by Tags").font(.headline).padding(.bottom, Spacing.xs)

            if allTags.isEmpty {
                Text("No tags yet")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(allTags) { tag in
                    Button {
                        if feedViewModel.selectedTags.contains(tag.id.uuidString) {
                            feedViewModel.selectedTags.remove(tag.id.uuidString)
                        } else {
                            feedViewModel.selectedTags.insert(tag.id.uuidString)
                        }
                        feedViewModel.startObservation()
                    } label: {
                        HStack {
                            Text("#\(tag.name)")
                            Spacer()
                            if feedViewModel.selectedTags.contains(tag.id.uuidString) {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.accentColor)
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
        .padding(Spacing.md)
        .frame(width: 200)
    }

    private var dateFilterPopover: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
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
        .padding(Spacing.md)
        .frame(width: 260)
    }

    private var activeFilterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Spacing.sm) {
                if let projectId = feedViewModel.selectedProjectId,
                   let project = projects.first(where: { $0.project.id.uuidString == projectId }) {
                    filterChip(label: project.name, icon: "folder") {
                        feedViewModel.selectedProjectId = nil
                        feedViewModel.startObservation()
                    }
                }

                ForEach(allTags.filter { feedViewModel.selectedTags.contains($0.id.uuidString) }) { tag in
                    filterChip(label: "#\(tag.name)", icon: "tag") {
                        feedViewModel.selectedTags.remove(tag.id.uuidString)
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
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.sm)
        }
    }

    private func filterChip(label: String, icon: String, onRemove: @escaping () -> Void) -> some View {
        HStack(spacing: Spacing.xs) {
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
        .pillStyle()
    }

    private var hasActiveFilters: Bool {
        feedViewModel.selectedProjectId != nil ||
        !feedViewModel.selectedTags.isEmpty ||
        feedViewModel.dateRange != nil
    }
}
