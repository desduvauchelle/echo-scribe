import SwiftUI

struct ProjectEditPopover: View {
    @State var name: String
    @State var color: String
    @State var projectDescription: String

    let isEditing: Bool
    let onSave: (String, String, String?) -> Void
    let onDelete: (() -> Void)?

    @State private var showDeleteConfirmation = false
    @Environment(\.dismiss) private var dismiss

    private static let presetColors = [
        "#007AFF", "#34C759", "#FF9500", "#FF3B30",
        "#AF52DE", "#FF2D55", "#5AC8FA", "#FFCC00",
        "#8E8E93", "#30B0C7"
    ]

    init(
        project: CDProject? = nil,
        onSave: @escaping (String, String, String?) -> Void,
        onDelete: (() -> Void)? = nil
    ) {
        _name = State(initialValue: project?.name ?? "")
        _color = State(initialValue: project?.color ?? "#007AFF")
        _projectDescription = State(initialValue: project?.projectDescription ?? "")
        self.isEditing = project != nil
        self.onSave = onSave
        self.onDelete = onDelete
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text(isEditing ? "Edit Project" : "New Project")
                .font(.headline)

            TextField("Project name", text: $name)
                .textFieldStyle(.roundedBorder)

            // Color swatches
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text("Color")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                LazyVGrid(columns: Array(repeating: GridItem(.fixed(24), spacing: Spacing.xs), count: 5), spacing: Spacing.xs) {
                    ForEach(Self.presetColors, id: \.self) { hex in
                        Circle()
                            .fill(Color(hex: hex) ?? .blue)
                            .frame(width: 24, height: 24)
                            .overlay(
                                Circle()
                                    .strokeBorder(.white, lineWidth: color == hex ? 2 : 0)
                            )
                            .overlay(
                                Circle()
                                    .strokeBorder(Color.primary.opacity(0.2), lineWidth: color == hex ? 1 : 0)
                                    .padding(-1)
                            )
                            .onTapGesture { color = hex }
                    }
                }
            }

            TextField("Description (optional)", text: $projectDescription, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...4)

            HStack {
                if isEditing, let onDelete {
                    Button(role: .destructive) {
                        showDeleteConfirmation = true
                    } label: {
                        Text("Delete")
                            .font(.caption)
                    }
                }

                Spacer()

                Button {
                    let desc = projectDescription.isEmpty ? nil : projectDescription
                    onSave(name, color, desc)
                } label: {
                    Text(isEditing ? "Save" : "Create")
                        .font(.caption)
                        .fontWeight(.medium)
                }
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                .keyboardShortcut(.return, modifiers: [])
            }
        }
        .padding(Spacing.md)
        .frame(width: 240)
        .alert("Delete Project?", isPresented: $showDeleteConfirmation) {
            Button("Delete", role: .destructive) { onDelete?() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will remove the project. Notes will become unassigned.")
        }
    }
}
