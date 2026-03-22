import SwiftUI

struct KanbanView: View {
    @Bindable var feedViewModel: FeedViewModel
    var projects: [ProjectWithCount]
    let database: AppDatabase

    private var columns: [(project: Project?, notes: [NoteWithDetails])] {
        var grouped: [String?: [NoteWithDetails]] = [:]
        for note in feedViewModel.notes {
            let key = note.note.projectId
            grouped[key, default: []].append(note)
        }

        var result: [(project: Project?, notes: [NoteWithDetails])] = []

        // Unassigned column first
        if let unassigned = grouped[nil], !unassigned.isEmpty {
            result.append((project: nil, notes: unassigned))
        }

        // Project columns
        for pwc in projects {
            let notes = grouped[pwc.project.id] ?? []
            if !notes.isEmpty {
                result.append((project: pwc.project, notes: notes))
            }
        }

        return result
    }

    var body: some View {
        if feedViewModel.notes.isEmpty {
            emptyState
        } else {
            ScrollView(.horizontal, showsIndicators: true) {
                HStack(alignment: .top, spacing: 16) {
                    ForEach(columns.indices, id: \.self) { index in
                        let column = columns[index]
                        kanbanColumn(project: column.project, notes: column.notes)
                    }
                }
                .padding()
            }
        }
    }

    private func kanbanColumn(project: Project?, notes: [NoteWithDetails]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // Column header
            HStack {
                if let project {
                    Circle()
                        .fill(Color(hex: project.color) ?? .blue)
                        .frame(width: 8, height: 8)
                    Text(project.name)
                        .font(.headline)
                } else {
                    Text("Unassigned")
                        .font(.headline)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Text("\(notes.count)")
                    .font(.caption)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
            }
            .padding(.horizontal, 8)

            Divider()

            // Cards
            ScrollView(.vertical, showsIndicators: false) {
                LazyVStack(spacing: 8) {
                    ForEach(notes, id: \.note.id) { noteDetail in
                        NoteCardView(noteDetail: noteDetail)
                            .draggable(noteDetail.note.id) {
                                Text(noteDetail.note.displayText)
                                    .font(.caption)
                                    .lineLimit(2)
                                    .padding(8)
                                    .background(.background, in: RoundedRectangle(cornerRadius: 8))
                            }
                    }
                }
            }
        }
        .frame(width: 280)
        .padding()
        .background(.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
        .dropDestination(for: String.self) { noteIds, _ in
            for noteId in noteIds {
                reassignNote(noteId: noteId, toProjectId: project?.id)
            }
            return true
        }
    }

    private func reassignNote(noteId: String, toProjectId: String?) {
        do {
            try database.reassignNoteProject(noteId: noteId, projectId: toProjectId)
        } catch {
            print("Failed to reassign note: \(error)")
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "rectangle.split.3x1")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("No notes to display")
                .font(.title2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
