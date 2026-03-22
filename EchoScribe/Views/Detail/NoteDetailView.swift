import SwiftUI
import CoreData

struct NoteDetailView: View {
    @ObservedObject var note: CDNote
    let projects: [CDProject]
    let onDismiss: () -> Void
    var onDelete: (() -> Void)?

    @Environment(\.managedObjectContext) private var context

    @State private var editedText: String = ""
    @State private var editedSummary: String = ""
    @State private var selectedProject: CDProject?
    @State private var tagText: String = ""
    @State private var tagNames: [String] = []
    @State private var isEditingText = false
    @State private var isEditingSummary = false
    @State private var editingTask: CDNoteTask?
    @State private var showDeleteConfirmation = false

    private var isNoteDeleted: Bool {
        note.managedObjectContext == nil || note.isDeleted
    }

    @ViewBuilder
    var body: some View {
        if isNoteDeleted {
            Color.clear
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
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

                    Divider()
                        .padding(.top, Spacing.xl)

                    Button {
                        showDeleteConfirmation = true
                    } label: {
                        Label("Delete Note", systemImage: "trash")
                            .foregroundStyle(.red.opacity(0.7))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, Spacing.sm)
                    .help("Delete note")
                }
                .padding(Spacing.lg)
            }
            .frame(minWidth: 350, maxWidth: .infinity, maxHeight: .infinity)
            .background(.background)
            .onAppear {
                editedText = note.displayText
                editedSummary = note.summary ?? ""
                selectedProject = note.project
                tagNames = note.tagsArray.map(\.name)
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text(note.createdAt.formatted(date: .long, time: .shortened))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if !note.isProcessed {
                    HStack(spacing: Spacing.sm) {
                        ProgressView().controlSize(.small)
                        Text("Processing...")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            Spacer()
            Button { onDismiss() } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(.tertiary)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.escape, modifiers: [])
        }
        .alert("Delete Note", isPresented: $showDeleteConfirmation) {
            Button("Delete", role: .destructive) {
                if let onDelete {
                    onDelete()
                } else {
                    context.delete(note)
                    try? context.save()
                    onDismiss()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Are you sure you want to delete this note? This cannot be undone.")
        }
    }

    // MARK: - Project

    private var projectSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Project")
                .sectionLabel()

            HStack {
                Picker("", selection: $selectedProject) {
                    Text("None").tag(CDProject?.none)
                    ForEach(projects) { project in
                        HStack {
                            Circle()
                                .fill(Color(hex: project.color) ?? .blue)
                                .frame(width: 8, height: 8)
                            Text(project.name)
                        }
                        .tag(CDProject?.some(project))
                    }
                }
                .labelsHidden()
                .onChange(of: selectedProject) { _, newProject in
                    note.project = newProject
                    note.updatedAt = Date()
                    try? context.save()
                }

                if note.isProcessed && selectedProject != nil {
                    Button("Reset AI Assignment") {
                        selectedProject = nil
                        note.project = nil
                        note.updatedAt = Date()
                        try? context.save()
                    }
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
            }
        }
    }

    // MARK: - Text

    private var textSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack {
                Text("Note")
                    .sectionLabel()
                Spacer()
                Button(isEditingText ? "Done" : "Edit") {
                    if isEditingText {
                        note.processedText = editedText
                        note.updatedAt = Date()
                        try? context.save()
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
                    .padding(Spacing.sm)
                    .background(AppColors.surface, in: RoundedRectangle(cornerRadius: Radius.sm))
            } else {
                Text(note.displayText)
                    .font(.body)
                    .textSelection(.enabled)
            }

            if note.processedText != nil {
                DisclosureGroup("Raw Transcript") {
                    Text(note.rawTranscript)
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
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack {
                Text("Summary")
                    .sectionLabel()
                Spacer()
                if note.summary != nil {
                    Button(isEditingSummary ? "Done" : "Edit") {
                        if isEditingSummary {
                            note.summary = editedSummary
                            note.updatedAt = Date()
                            try? context.save()
                        }
                        isEditingSummary.toggle()
                    }
                    .font(.caption)
                }
            }

            if isEditingSummary {
                TextField("Summary", text: $editedSummary)
                    .textFieldStyle(.roundedBorder)
            } else if let summary = note.summary {
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
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack {
                Text("Tags")
                    .sectionLabel()
                Spacer()
                if note.isProcessed && !tagNames.isEmpty {
                    Button("Reset AI Tags") {
                        tagNames = []
                        setTags([])
                    }
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
            }

            FlowLayout(spacing: Spacing.sm) {
                ForEach(tagNames, id: \.self) { tag in
                    HStack(spacing: Spacing.xs) {
                        Text("#\(tag)")
                            .font(.caption)
                        Button {
                            tagNames.removeAll { $0 == tag }
                            setTags(tagNames)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 8, weight: .bold))
                        }
                        .buttonStyle(.plain)
                    }
                    .pillStyle()
                }
            }

            HStack {
                TextField("Add tag...", text: $tagText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { addTag() }
                Button("Add") { addTag() }
                    .disabled(tagText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    // MARK: - Tasks

    private var tasksSection: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Tasks")
                .sectionLabel()

            if note.tasksArray.isEmpty {
                Text("No tasks")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
            } else {
                ForEach(note.tasksArray) { task in
                    HStack(spacing: Spacing.sm) {
                        Button {
                            task.isCompleted.toggle()
                            try? context.save()
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
                                .foregroundStyle(.tertiary)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.vertical, Spacing.xs)
                }
            }
        }
        .sheet(item: $editingTask) { task in
            TaskDetailView(task: task, projects: projects)
        }
    }

    // MARK: - Helpers

    private func addTag() {
        let name = tagText.trimmingCharacters(in: .whitespaces).lowercased()
        guard !name.isEmpty, !tagNames.contains(name) else { return }
        tagNames.append(name)
        tagText = ""
        setTags(tagNames)
    }

    private func setTags(_ names: [String]) {
        note.removeFromTags(note.tags)
        for name in names {
            let tag = CDTag.findOrCreate(name: name, in: context)
            note.addToTags(tag)
        }
        note.updatedAt = Date()
        try? context.save()
    }
}
