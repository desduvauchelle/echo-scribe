import SwiftUI
import CoreData

struct KanbanView: View {
    @Bindable var feedViewModel: FeedViewModel
    var projects: [ProjectWithCount]

    @Environment(\.managedObjectContext) private var context

    private var columns: [(project: CDProject?, notes: [NoteWithDetails])] {
        var grouped: [UUID?: [NoteWithDetails]] = [:]
        for note in feedViewModel.notes {
            let key = note.note.project?.id
            grouped[key, default: []].append(note)
        }

        var result: [(project: CDProject?, notes: [NoteWithDetails])] = []

        if let unassigned = grouped[nil], !unassigned.isEmpty {
            result.append((project: nil, notes: unassigned))
        }

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
                HStack(alignment: .top, spacing: Spacing.md) {
                    ForEach(columns.indices, id: \.self) { index in
                        let column = columns[index]
                        kanbanColumn(project: column.project, notes: column.notes)
                    }
                }
                .padding(Spacing.md)
            }
        }
    }

    private func kanbanColumn(project: CDProject?, notes: [NoteWithDetails]) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack {
                if let project {
                    Circle()
                        .fill(Color(hex: project.color) ?? .blue)
                        .frame(width: 8, height: 8)
                    Text(project.name)
                        .font(.subheadline)
                        .fontWeight(.semibold)
                } else {
                    Text("Unassigned")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Text("\(notes.count)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, Spacing.sm)
                    .padding(.vertical, Spacing.xs)
                    .background(.quaternary, in: Capsule())
            }
            .padding(.horizontal, Spacing.sm)

            Divider()

            ScrollView(.vertical, showsIndicators: false) {
                LazyVStack(spacing: Spacing.sm) {
                    ForEach(notes) { noteDetail in
                        NoteCardView(noteDetail: noteDetail)
                            .draggable(noteDetail.note.id.uuidString) {
                                Text(noteDetail.note.displayText)
                                    .font(.caption)
                                    .lineLimit(2)
                                    .padding(Spacing.sm)
                                    .background(.background, in: RoundedRectangle(cornerRadius: Radius.sm))
                            }
                    }
                }
            }
        }
        .frame(width: 280)
        .padding(Spacing.md)
        .background(AppColors.surface, in: RoundedRectangle(cornerRadius: Radius.md))
        .dropDestination(for: String.self) { noteIdStrings, _ in
            for idString in noteIdStrings {
                reassignNote(idString: idString, toProject: project)
            }
            return true
        }
    }

    private func reassignNote(idString: String, toProject project: CDProject?) {
        guard let uuid = UUID(uuidString: idString) else { return }
        let request: NSFetchRequest<CDNote> = CDNote.fetchRequest()
        request.predicate = NSPredicate(format: "id == %@", uuid as CVarArg)
        request.fetchLimit = 1
        guard let note = try? context.fetch(request).first else { return }
        note.project = project
        note.updatedAt = Date()
        try? context.save()
    }

    private var emptyState: some View {
        VStack(spacing: Spacing.md) {
            Image(systemName: "rectangle.split.3x1")
                .font(.system(size: 36))
                .foregroundStyle(.tertiary)
            Text("No notes to display")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
