import SwiftUI
import CoreData

struct TaskDetailView: View {
    @ObservedObject var task: CDNoteTask
    let projects: [CDProject]

    @Environment(\.managedObjectContext) private var context
    @Environment(\.dismiss) private var dismiss

    @State private var title: String = ""
    @State private var dueDate: Date = Date()
    @State private var hasDueDate = false
    @State private var selectedProject: CDProject?

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
            .padding(Spacing.md)

            Divider()

            Form {
                TextField("Title", text: $title)

                Picker("Project", selection: $selectedProject) {
                    Text("None").tag(CDProject?.none)
                    ForEach(projects) { project in
                        Text(project.name).tag(CDProject?.some(project))
                    }
                }

                Toggle("Has Due Date", isOn: $hasDueDate)

                if hasDueDate {
                    DatePicker("Due Date", selection: $dueDate, displayedComponents: .date)
                }

                Section {
                    Button("Delete Task", role: .destructive) {
                        context.delete(task)
                        try? context.save()
                        dismiss()
                    }
                }
            }
            .formStyle(.grouped)
        }
        .frame(width: 400, height: 320)
        .onAppear {
            title = task.title
            selectedProject = task.project
            hasDueDate = task.dueDate != nil
            dueDate = task.dueDate ?? Date()
        }
    }

    private func save() {
        task.title = title
        task.dueDate = hasDueDate ? dueDate : nil
        task.project = selectedProject
        try? context.save()
    }
}
