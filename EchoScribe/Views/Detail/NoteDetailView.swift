import SwiftUI

struct NoteDetailView: View {
    let noteDetail: NoteWithDetails
    let projects: [Project]
    let database: AppDatabase
    let onDismiss: () -> Void

    @State private var editedText: String = ""
    @State private var editedSummary: String = ""
    @State private var selectedProjectId: String?
    @State private var tagText: String = ""
    @State private var tags: [String] = []
    @State private var isEditingText = false
    @State private var isEditingSummary = false
    @State private var editingTask: NoteTask?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                Divider()
                projectSection
                Divider()
                textSection
                Divider()
                summarySection
                Divider()
                tagsSection
                Divider()
                tasksSection
            }
            .padding(20)
        }
        .frame(minWidth: 350, maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
        .onAppear {
            editedText = noteDetail.note.displayText
            editedSummary = noteDetail.note.summary ?? ""
            selectedProjectId = noteDetail.note.projectId
            tags = noteDetail.tags.map(\.name)
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(noteDetail.note.createdAt.formatted(date: .long, time: .shortened))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if !noteDetail.note.isProcessed {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Processing with AI...")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Spacer()
            Button { onDismiss() } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.escape, modifiers: [])
        }
    }

    // MARK: - Project

    private var projectSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Project")
                .font(.caption)
                .foregroundStyle(.secondary)
                .textCase(.uppercase)

            HStack {
                Picker("", selection: $selectedProjectId) {
                    Text("None").tag(String?.none)
                    ForEach(projects) { project in
                        HStack {
                            Circle()
                                .fill(Color(hex: project.color) ?? .blue)
                                .frame(width: 8, height: 8)
                            Text(project.name)
                        }
                        .tag(Optional(project.id))
                    }
                }
                .labelsHidden()
                .onChange(of: selectedProjectId) { _, newValue in
                    try? database.reassignNoteProject(noteId: noteDetail.note.id, projectId: newValue)
                }

                if noteDetail.note.isProcessed && selectedProjectId != nil {
                    Button("Reset AI Assignment") {
                        selectedProjectId = nil
                        try? database.reassignNoteProject(noteId: noteDetail.note.id, projectId: nil)
                    }
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
            }
        }
    }

    // MARK: - Text

    private var textSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Note")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                Spacer()
                Button(isEditingText ? "Done" : "Edit") {
                    if isEditingText {
                        try? database.updateNoteText(noteId: noteDetail.note.id, processedText: editedText)
                    }
                    isEditingText.toggle()
                }
                .font(.caption)
            }

            if isEditingText {
                TextEditor(text: $editedText)
                    .font(.body)
                    .frame(minHeight: 120)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            } else {
                Text(noteDetail.note.displayText)
                    .font(.body)
                    .textSelection(.enabled)
            }

            if noteDetail.note.processedText != nil {
                DisclosureGroup("Raw Transcript") {
                    Text(noteDetail.note.rawTranscript)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Summary

    private var summarySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Summary")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                Spacer()
                if noteDetail.note.summary != nil {
                    Button(isEditingSummary ? "Done" : "Edit") {
                        if isEditingSummary {
                            try? database.updateNoteSummary(noteId: noteDetail.note.id, summary: editedSummary)
                        }
                        isEditingSummary.toggle()
                    }
                    .font(.caption)
                }
            }

            if isEditingSummary {
                TextField("Summary", text: $editedSummary)
                    .textFieldStyle(.roundedBorder)
            } else if let summary = noteDetail.note.summary {
                Text(summary)
                    .font(.subheadline)
                    .italic()
                    .textSelection(.enabled)
            } else {
                Text("No summary yet")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: - Tags

    private var tagsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Tags")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                Spacer()
                if noteDetail.note.isProcessed && !tags.isEmpty {
                    Button("Reset AI Tags") {
                        tags = []
                        try? database.setNoteTags(noteId: noteDetail.note.id, tagNames: [])
                    }
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
            }

            FlowLayout(spacing: 6) {
                ForEach(tags, id: \.self) { tag in
                    HStack(spacing: 4) {
                        Text("#\(tag)")
                            .font(.caption)
                        Button {
                            tags.removeAll { $0 == tag }
                            try? database.setNoteTags(noteId: noteDetail.note.id, tagNames: tags)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 8, weight: .bold))
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.blue.opacity(0.1), in: Capsule())
                    .foregroundStyle(.blue)
                }
            }

            HStack {
                TextField("Add tag...", text: $tagText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit {
                        addTag()
                    }
                Button("Add") {
                    addTag()
                }
                .disabled(tagText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    // MARK: - Tasks

    private var tasksSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Tasks")
                .font(.caption)
                .foregroundStyle(.secondary)
                .textCase(.uppercase)

            if noteDetail.tasks.isEmpty {
                Text("No tasks")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
            } else {
                ForEach(noteDetail.tasks) { task in
                    HStack(spacing: 8) {
                        Button {
                            try? database.toggleTaskCompletion(id: task.id)
                        } label: {
                            Image(systemName: task.isCompleted ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(task.isCompleted ? .green : .secondary)
                        }
                        .buttonStyle(.plain)

                        Text(task.title)
                            .strikethrough(task.isCompleted)
                            .font(.body)

                        Spacer()

                        if let dueDate = task.dueDate {
                            Text(dueDate.formatted(date: .abbreviated, time: .omitted))
                                .font(.caption)
                                .foregroundStyle(.orange)
                        }

                        Button {
                            editingTask = task
                        } label: {
                            Image(systemName: "pencil")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .sheet(item: $editingTask) { task in
            TaskDetailView(
                task: task,
                projects: projects,
                database: database
            )
        }
    }

    // MARK: - Helpers

    private func addTag() {
        let name = tagText.trimmingCharacters(in: .whitespaces).lowercased()
        guard !name.isEmpty, !tags.contains(name) else { return }
        tags.append(name)
        tagText = ""
        try? database.setNoteTags(noteId: noteDetail.note.id, tagNames: tags)
    }
}
