import SwiftUI

struct ProjectGroupView: View {
    @Bindable var feedViewModel: FeedViewModel
    var projects: [ProjectWithCount]

    private var grouped: [(project: Project?, notes: [NoteWithDetails])] {
        var byProject: [String?: [NoteWithDetails]] = [:]
        for note in feedViewModel.notes {
            byProject[note.note.projectId, default: []].append(note)
        }

        var result: [(project: Project?, notes: [NoteWithDetails])] = []

        // Named projects
        for pwc in projects {
            if let notes = byProject[pwc.project.id], !notes.isEmpty {
                result.append((project: pwc.project, notes: notes))
            }
        }

        // Unassigned
        if let unassigned = byProject[nil], !unassigned.isEmpty {
            result.append((project: nil, notes: unassigned))
        }

        return result
    }

    var body: some View {
        if feedViewModel.notes.isEmpty {
            emptyState
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(grouped.indices, id: \.self) { index in
                        let group = grouped[index]
                        projectSection(project: group.project, notes: group.notes)
                    }
                }
                .padding()
            }
        }
    }

    private func projectSection(project: Project?, notes: [NoteWithDetails]) -> some View {
        DisclosureGroup {
            ForEach(notes, id: \.note.id) { noteDetail in
                NoteCardView(noteDetail: noteDetail)
            }
        } label: {
            HStack(spacing: 8) {
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
                    .font(.caption)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "folder")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("No notes to display")
                .font(.title2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
