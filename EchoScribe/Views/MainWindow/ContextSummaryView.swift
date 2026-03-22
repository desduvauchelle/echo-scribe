import SwiftUI
import CoreData

struct ContextSummaryView: View {
    @Bindable var feedViewModel: FeedViewModel
    var onTapTasks: () -> Void
    var onTapRecent: () -> Void

    @Environment(\.managedObjectContext) private var context
    @State private var tasksDueCount = 0

    var body: some View {
        HStack(spacing: Spacing.md) {
            if tasksDueCount > 0 {
                summaryChip(
                    icon: "checkmark.circle",
                    text: "\(tasksDueCount) task\(tasksDueCount == 1 ? "" : "s") due",
                    action: onTapTasks
                )
            }

            summaryChip(
                icon: "doc.text",
                text: "\(feedViewModel.notes.count) note\(feedViewModel.notes.count == 1 ? "" : "s")",
                action: onTapRecent
            )

            Spacer()
        }
        .task {
            loadCounts()
        }
    }

    private func summaryChip(icon: String, text: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Spacing.xs) {
                Image(systemName: icon)
                    .font(.caption2)
                Text(text)
                    .font(.caption)
            }
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            if hovering {
                NSCursor.pointingHand.push()
            } else {
                NSCursor.pop()
            }
        }
    }

    private func loadCounts() {
        let today = Calendar.current.startOfDay(for: Date())
        let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: today)!

        let request: NSFetchRequest<CDNoteTask> = CDNoteTask.fetchRequest()
        request.predicate = NSPredicate(
            format: "isCompleted == NO AND dueDate >= %@ AND dueDate < %@",
            today as NSDate, tomorrow as NSDate
        )
        tasksDueCount = (try? context.count(for: request)) ?? 0
    }
}
