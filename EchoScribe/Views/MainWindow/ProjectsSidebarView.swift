import SwiftUI

struct ProjectsSidebarView: View {
    @Bindable var projectsViewModel: ProjectsViewModel
    @Bindable var feedViewModel: FeedViewModel
    @Bindable var appState: AppState

    @State private var showCreatePopover = false
    @State private var editingProject: CDProject?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            sidebarHeader
            Divider()
            projectList
        }
        .background(.ultraThinMaterial)
    }

    // MARK: - Header

    private var sidebarHeader: some View {
        HStack {
            Text("Projects")
                .font(.headline)

            Spacer()

            Button {
                showCreatePopover = true
            } label: {
                Image(systemName: "plus")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showCreatePopover) {
                ProjectEditPopover { name, color, description in
                    projectsViewModel.createProject(name: name, color: color, description: description)
                    showCreatePopover = false
                }
            }
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.sm + 2)
    }

    // MARK: - Project List

    private var projectList: some View {
        ScrollView {
            VStack(spacing: 2) {
                allNotesRow

                ForEach(projectsViewModel.projects, id: \.project.id) { pwc in
                    projectRow(pwc)
                }
            }
            .padding(.vertical, Spacing.sm)
            .padding(.horizontal, Spacing.sm)
        }
        .popover(item: $editingProject) { project in
            ProjectEditPopover(
                project: project,
                onSave: { name, color, description in
                    projectsViewModel.updateProject(project, name: name, color: color, description: description)
                    editingProject = nil
                },
                onDelete: {
                    if appState.selectedProjectId == project.id.uuidString {
                        feedViewModel.selectedProjectId = nil
                        appState.selectedProjectId = nil
                    }
                    projectsViewModel.deleteProject(project)
                    editingProject = nil
                }
            )
        }
    }

    // MARK: - All Notes Row

    private var allNotesRow: some View {
        Button {
            withAnimation(AppAnimation.quick) {
                feedViewModel.selectedProjectId = nil
                appState.selectedProjectId = nil
            }
        } label: {
            HStack(spacing: Spacing.sm) {
                Image(systemName: "tray.full")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: 14)

                Text("All Notes")
                    .font(.subheadline)

                Spacer()
            }
            .padding(.horizontal, Spacing.sm)
            .padding(.vertical, Spacing.xs + 2)
            .background(
                RoundedRectangle(cornerRadius: Radius.sm)
                    .fill(appState.selectedProjectId == nil ? Color.accentColor.opacity(0.12) : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Project Row

    private func projectRow(_ pwc: ProjectWithCount) -> some View {
        let project = pwc.project
        let isSelected = appState.selectedProjectId == project.id.uuidString

        return Button {
            withAnimation(AppAnimation.quick) {
                let idString = project.id.uuidString
                feedViewModel.selectedProjectId = idString
                appState.selectedProjectId = idString
            }
        } label: {
            HStack(spacing: Spacing.sm) {
                Circle()
                    .fill(Color(hex: pwc.color) ?? .blue)
                    .frame(width: 10, height: 10)

                Text(pwc.name)
                    .font(.subheadline)
                    .lineLimit(1)

                Spacer()

                // Info button
                Button {
                    editingProject = project
                } label: {
                    Image(systemName: "info.circle")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, Spacing.sm)
            .padding(.vertical, Spacing.xs + 2)
            .background(
                RoundedRectangle(cornerRadius: Radius.sm)
                    .fill(isSelected ? Color.accentColor.opacity(0.12) : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
