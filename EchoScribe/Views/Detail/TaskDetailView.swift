import SwiftUI

struct TaskDetailView: View {
    let task: NoteTask
    let projects: [Project]
    let database: AppDatabase

    @State private var title: String = ""
    @State private var dueDate: Date = Date()
    @State private var hasDueDate = false
    @State private var selectedProjectId: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Edit Task")
                    .font(.headline)
                Spacer()
                Button("Done") {
                    save()
                    dismiss()
                }
                .keyboardShortcut(.return, modifiers: .command)
            }
            .padding()

            Divider()

            Form {
                TextField("Title", text: $title)

                Picker("Project", selection: $selectedProjectId) {
                    Text("None").tag(String?.none)
                    ForEach(projects) { project in
                        Text(project.name).tag(Optional(project.id))
                    }
                }

                Toggle("Has Due Date", isOn: $hasDueDate)

                if hasDueDate {
                    DatePicker("Due Date", selection: $dueDate, displayedComponents: .date)
                }

                Section {
                    Button("Delete Task", role: .destructive) {
                        try? database.deleteTask(id: task.id)
                        dismiss()
                    }
                }
            }
            .formStyle(.grouped)
        }
        .frame(width: 400, height: 320)
        .onAppear {
            title = task.title
            selectedProjectId = task.projectId
            hasDueDate = task.dueDate != nil
            dueDate = task.dueDate ?? Date()
        }
    }

    private func save() {
        let finalDueDate = hasDueDate ? dueDate : nil
        try? database.updateTask(
            id: task.id,
            title: title,
            dueDate: finalDueDate,
            projectId: selectedProjectId
        )
    }
}
