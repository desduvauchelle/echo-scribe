import SwiftUI

struct ProjectGroupView: View {
    @Bindable var feedViewModel: FeedViewModel
    var projects: [ProjectWithCount]

    private var grouped: [(project: CDProject?, notes: [NoteWithDetails])] {
        var byProject: [UUID?: [NoteWithDetails]] = [:]
        for note in feedViewModel.notes {
            byProject[note.note.project?.id, default: []].append(note)
        }

        var result: [(project: CDProject?, notes: [NoteWithDetails])] = []

        for pwc in projects {
            if let notes = byProject[pwc.project.id], !notes.isEmpty {
                result.append((project: pwc.project, notes: notes))
            }
        }

        if let unassigned = byProject[nil], !unassigned.isEmpty {
            result.append((project: nil, notes: unassigned))
        }

        return result
    }

    var body: some View {
        if feedViewModel.notes.isEmpty {
            emptyState
        } else {
            LazyVStack(alignment: .leading, spacing: Spacing.lg) {
                ForEach(grouped.indices, id: \.self) { index in
                    let group = grouped[index]
                    projectSection(project: group.project, notes: group.notes)
                }
            }
            .padding(.bottom, Spacing.xl)
        }
    }

    private func projectSection(project: CDProject?, notes: [NoteWithDetails]) -> some View {
        DisclosureGroup {
            ForEach(notes) { noteDetail in
                NoteCardView(noteDetail: noteDetail)
            }
        } label: {
            HStack(spacing: Spacing.sm) {
                if let project {
                    Circle()
                        .fill(Color(hex: project.color) ?? .blue)
                        .frame(width: 10, height: 10)
                    Text(project.name)
                        .font(.title3)
                        .fontWeight(.semibold)
                } else {
                    Circle()
                        .fill(.gray)
                        .frame(width: 10, height: 10)
                    Text("Unassigned")
                        .font(.title3)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                }

                Text("\(notes.count)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, Spacing.sm)
                    .padding(.vertical, Spacing.xs)
                    .background(.quaternary, in: Capsule())
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: Spacing.md) {
            Image(systemName: "folder")
                .font(.system(size: 36))
                .foregroundStyle(.tertiary)
            Text("No notes to display")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
