import SwiftUI

struct ProjectGroupView: View {
    @Bindable var feedViewModel: FeedViewModel
    var projects: [ProjectWithCount]

    private enum ProjectSelection: Hashable {
        case project(UUID)
        case unassigned
    }

    @State private var selection: ProjectSelection?

    private var selectedNotes: [NoteWithDetails] {
        switch selection {
        case .project(let id):
            return feedViewModel.notes.filter { $0.note.project?.id == id }
        case .unassigned:
            return feedViewModel.notes.filter { $0.note.project == nil }
        case nil:
            return []
        }
    }

    private var unassignedNoteCount: Int {
        feedViewModel.notes.filter { $0.note.project == nil }.count
    }

    var body: some View {
        if projects.isEmpty && unassignedNoteCount == 0 {
            emptyState
        } else {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                projectBarList

                if selection != nil {
                    selectedProjectNotes
                }
            }
            .padding(.bottom, Spacing.xl)
        }
    }

    // MARK: - Project Bar List

    private var projectBarList: some View {
        VStack(spacing: Spacing.sm) {
            ForEach(projects, id: \.project.id) { projectWithCount in
                projectBar(projectWithCount)
            }

            if unassignedNoteCount > 0 {
                unassignedBar
            }
        }
    }

    // MARK: - Project Bar

    private func projectBar(_ projectWithCount: ProjectWithCount) -> some View {
        let project = projectWithCount.project
        let isSelected = selection == .project(project.id)
        let projectColor = Color(hex: project.color) ?? .blue

        return Button {
            withAnimation(AppAnimation.gentle) {
                selection = isSelected ? nil : .project(project.id)
            }
        } label: {
            HStack(spacing: Spacing.sm) {
                Circle()
                    .fill(projectColor)
                    .frame(width: 10, height: 10)

                Text(project.name)
                    .font(.body)
                    .fontWeight(.bold)

                Spacer()

                Text("\(projectWithCount.noteCount)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, Spacing.sm)
                    .padding(.vertical, Spacing.xs)
                    .background(.quaternary, in: Capsule())
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.sm + 2)
            .background(
                RoundedRectangle(cornerRadius: Radius.md)
                    .fill(isSelected ? projectColor.opacity(0.15) : projectColor.opacity(0.06))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Radius.md)
                    .strokeBorder(isSelected ? projectColor.opacity(0.3) : Color.clear, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Unassigned Bar

    private var unassignedBar: some View {
        let isSelected = selection == .unassigned
        return Button {
            withAnimation(AppAnimation.gentle) {
                selection = isSelected ? nil : .unassigned
            }
        } label: {
            HStack(spacing: Spacing.sm) {
                Circle()
                    .fill(.gray)
                    .frame(width: 10, height: 10)

                Text("Unassigned")
                    .font(.body)
                    .fontWeight(.bold)
                    .foregroundStyle(.secondary)

                Spacer()

                Text("\(unassignedNoteCount)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, Spacing.sm)
                    .padding(.vertical, Spacing.xs)
                    .background(.quaternary, in: Capsule())
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.sm + 2)
            .background(
                RoundedRectangle(cornerRadius: Radius.md)
                    .fill(isSelected ? Color.gray.opacity(0.15) : Color.gray.opacity(0.06))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Radius.md)
                    .strokeBorder(isSelected ? Color.gray.opacity(0.3) : Color.clear, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Selected Project Notes

    private var selectedProjectNotes: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            if selectedNotes.isEmpty {
                Text("No notes in this project yet")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, Spacing.lg)
                    .frame(maxWidth: .infinity)
            } else {
                ForEach(selectedNotes) { noteDetail in
                    NoteCardView(noteDetail: noteDetail)
                }
            }
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: Spacing.md) {
            Image(systemName: "folder")
                .font(.system(size: 36))
                .foregroundStyle(.tertiary)
            Text("No projects yet")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("Create a project from the sidebar")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
