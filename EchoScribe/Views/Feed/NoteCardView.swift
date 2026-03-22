import SwiftUI

struct NoteCardView: View {
    let noteDetail: NoteWithDetails
    var isSelected = false
    var isExpanded = false

    @Environment(\.managedObjectContext) private var context

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack {
                if let project = noteDetail.project {
                    HStack(spacing: Spacing.xs) {
                        Circle()
                            .fill(Color(hex: project.color) ?? .blue)
                            .frame(width: 6, height: 6)
                        Text(project.name)
                            .font(.caption2)
                            .fontWeight(.medium)
                    }
                    .pillStyle()
                }

                Spacer()

                Text(noteDetail.note.createdAt.formatted(.relative(presentation: .named)))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            Text(noteDetail.note.displayText)
                .font(.body)
                .lineLimit(isExpanded ? nil : 2)
                .foregroundStyle(.primary)

            if !noteDetail.note.isProcessed {
                HStack(spacing: Spacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Processing...")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }

            if isExpanded || isSelected {
                expandedContent
            } else {
                collapsedMeta
            }
        }
        .cardStyle(isSelected: isSelected)
    }

    @ViewBuilder
    private var collapsedMeta: some View {
        HStack(spacing: Spacing.sm) {
            if !noteDetail.tags.isEmpty {
                HStack(spacing: Spacing.xs) {
                    Image(systemName: "tag")
                        .font(.caption2)
                    Text("\(noteDetail.tags.count)")
                        .font(.caption2)
                }
                .foregroundStyle(.tertiary)
            }

            if !noteDetail.tasks.isEmpty {
                let completed = noteDetail.tasks.filter(\.isCompleted).count
                HStack(spacing: Spacing.xs) {
                    Image(systemName: "checkmark.circle")
                        .font(.caption2)
                    Text("\(completed)/\(noteDetail.tasks.count)")
                        .font(.caption2)
                }
                .foregroundStyle(.tertiary)
            }
        }
    }

    @ViewBuilder
    private var expandedContent: some View {
        if let summary = noteDetail.note.summary, noteDetail.note.isProcessed {
            Text(summary)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .italic()
        }

        if !noteDetail.tags.isEmpty {
            FlowLayout(spacing: Spacing.xs) {
                ForEach(noteDetail.tags) { tag in
                    Text("#\(tag.name)")
                        .pillStyle()
                }
            }
        }

        if !noteDetail.tasks.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                ForEach(noteDetail.tasks) { task in
                    HStack(spacing: Spacing.sm) {
                        Button {
                            task.isCompleted.toggle()
                            try? context.save()
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
}

/// Simple flow layout for tags
struct FlowLayout: Layout {
    var spacing: CGFloat = Spacing.xs

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
