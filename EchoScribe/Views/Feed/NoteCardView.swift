import SwiftUI

struct NoteCardView: View {
    let noteDetail: NoteWithDetails
    var database: AppDatabase = .shared
    var isSelected = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Header: project badge + timestamp
            HStack {
                if let project = noteDetail.project {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(Color(hex: project.color) ?? .blue)
                            .frame(width: 6, height: 6)
                        Text(project.name)
                            .font(.caption)
                            .fontWeight(.medium)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
                }

                Spacer()

                Text(noteDetail.note.createdAt.formatted(.relative(presentation: .named)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Note text
            Text(noteDetail.note.displayText)
                .font(.body)
                .lineLimit(4)

            // Summary (if processed)
            if let summary = noteDetail.note.summary, noteDetail.note.isProcessed {
                Text(summary)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .italic()
            }

            // Processing indicator
            if !noteDetail.note.isProcessed {
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Processing with AI...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            // Tags
            if !noteDetail.tags.isEmpty {
                FlowLayout(spacing: 4) {
                    ForEach(noteDetail.tags) { tag in
                        Text("#\(tag.name)")
                            .font(.caption2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.blue.opacity(0.1), in: Capsule())
                            .foregroundStyle(.blue)
                    }
                }
            }

            // Tasks
            if !noteDetail.tasks.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(noteDetail.tasks) { task in
                        HStack(spacing: 6) {
                            Button {
                                try? database.toggleTaskCompletion(id: task.id)
                            } label: {
                                Image(systemName: task.isCompleted ? "checkmark.circle.fill" : "circle")
                                    .font(.caption)
                                    .foregroundStyle(task.isCompleted ? .green : .secondary)
                            }
                            .buttonStyle(.plain)
                            Text(task.title)
                                .font(.caption)
                                .strikethrough(task.isCompleted)
                                .foregroundStyle(task.isCompleted ? .secondary : .primary)
                            if let dueDate = task.dueDate {
                                Spacer()
                                Text(dueDate.formatted(date: .abbreviated, time: .omitted))
                                    .font(.caption2)
                                    .foregroundStyle(.orange)
                            }
                        }
                    }
                }
            }
        }
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(.background)
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(isSelected ? Color.accentColor : .clear, lineWidth: 2)
                )
        )
        .shadow(color: .black.opacity(0.05), radius: 2, y: 1)
    }
}

/// Simple flow layout for tags
struct FlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        return layout(sizes: sizes, containerWidth: proposal.width ?? .infinity).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let offsets = layout(sizes: sizes, containerWidth: bounds.width).offsets

        for (index, subview) in subviews.enumerated() {
            subview.place(at: CGPoint(
                x: bounds.minX + offsets[index].x,
                y: bounds.minY + offsets[index].y
            ), proposal: .unspecified)
        }
    }

    private func layout(sizes: [CGSize], containerWidth: CGFloat) -> (offsets: [CGPoint], size: CGSize) {
        var offsets: [CGPoint] = []
        var currentX: CGFloat = 0
        var currentY: CGFloat = 0
        var lineHeight: CGFloat = 0
        var maxWidth: CGFloat = 0

        for size in sizes {
            if currentX + size.width > containerWidth, currentX > 0 {
                currentX = 0
                currentY += lineHeight + spacing
                lineHeight = 0
            }
            offsets.append(CGPoint(x: currentX, y: currentY))
            lineHeight = max(lineHeight, size.height)
            currentX += size.width + spacing
            maxWidth = max(maxWidth, currentX)
        }

        return (offsets, CGSize(width: maxWidth, height: currentY + lineHeight))
    }
}
