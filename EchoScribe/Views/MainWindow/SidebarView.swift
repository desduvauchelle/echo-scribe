import SwiftUI

enum SmartFilter: String, Identifiable {
    case all = "all"
    case todaysTasks = "todaysTasks"
    case recent = "recent"
    case unprocessed = "unprocessed"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: return "All Notes"
        case .todaysTasks: return "Today's Tasks"
        case .recent: return "Last 7 Days"
        case .unprocessed: return "Unprocessed"
        }
    }

    var icon: String {
        switch self {
        case .all: return "doc.text"
        case .todaysTasks: return "checkmark.circle"
        case .recent: return "clock"
        case .unprocessed: return "sparkles"
        }
    }
}

struct SidebarView: View {
    @Bindable var projectsViewModel: ProjectsViewModel
    @Binding var selectedProjectId: String?
    @Binding var selectedSmartFilter: SmartFilter
    @State private var showNewProjectSheet = false
    @State private var newProjectName = ""
    @State private var newProjectDescription = ""
    @State private var editingProject: CDProject? = nil
    @State private var editingDescription = ""
    @FocusState private var isProjectNameFieldFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            Text("Echo Scribe")
                .font(.title3)
                .fontWeight(.semibold)
                .padding(.horizontal, Spacing.md)
                .padding(.top, Spacing.md)

            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text("FILTERS")
                    .sectionLabel()
                    .padding(.horizontal, Spacing.md)

                ForEach([SmartFilter.all, .todaysTasks, .recent, .unprocessed]) { filter in
                    filterRow(filter)
                }
            }

            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack {
                    Text("PROJECTS")
                        .sectionLabel()
                    Spacer()
                    Button {
                        showNewProjectSheet = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, Spacing.md)

                ForEach(projectsViewModel.projects, id: \.project.id) { projectWithCount in
                    projectRow(projectWithCount)
                }
            }

            Spacer()
        }
        .sheet(isPresented: $showNewProjectSheet) {
            VStack(spacing: Spacing.md) {
                Text("New Project").font(.headline)
                TextField("Project name", text: $newProjectName)
                    .textFieldStyle(.roundedBorder)
                    .focused($isProjectNameFieldFocused)
                TextField("Description (helps AI categorize notes)", text: $newProjectDescription, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(2...4)
                HStack {
                    Button("Cancel") {
                        isProjectNameFieldFocused = false
                        newProjectName = ""
                        newProjectDescription = ""
                        showNewProjectSheet = false
                    }
                    Spacer()
                    Button("Create") {
                        if !newProjectName.isEmpty {
                            isProjectNameFieldFocused = false
                            projectsViewModel.createProject(name: newProjectName, description: newProjectDescription.isEmpty ? nil : newProjectDescription)
                            newProjectName = ""
                            newProjectDescription = ""
                            showNewProjectSheet = false
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(newProjectName.isEmpty)
                }
            }
            .padding(Spacing.lg)
            .frame(width: 300)
            .onAppear {
                isProjectNameFieldFocused = true
            }
        }
        .sheet(item: $editingProject) { project in
            VStack(spacing: Spacing.md) {
                Text("Edit Description").font(.headline)
                Text(project.name).foregroundStyle(.secondary)
                TextField("Description (helps AI categorize notes)", text: $editingDescription, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(2...6)
                HStack {
                    Button("Cancel") {
                        editingProject = nil
                    }
                    Spacer()
                    Button("Save") {
                        projectsViewModel.updateProjectDescription(project, description: editingDescription.isEmpty ? nil : editingDescription)
                        editingProject = nil
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .padding(Spacing.lg)
            .frame(width: 350)
        }
    }

    private func filterRow(_ filter: SmartFilter) -> some View {
        let isActive = selectedSmartFilter == filter && selectedProjectId == nil
        return Button {
            selectedSmartFilter = filter
            selectedProjectId = nil
        } label: {
            HStack(spacing: Spacing.sm) {
                Image(systemName: filter.icon)
                    .font(.caption)
                    .frame(width: 20)
                Text(filter.label)
                    .font(.body)
                Spacer()
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.xs + 2)
            .background(
                RoundedRectangle(cornerRadius: Radius.sm)
                    .fill(isActive ? Color.accentColor.opacity(0.12) : Color.clear)
                    .padding(.horizontal, Spacing.sm)
            )
            .foregroundStyle(isActive ? Color.accentColor : .primary)
        }
        .buttonStyle(.plain)
    }

    private func projectRow(_ projectWithCount: ProjectWithCount) -> some View {
        let isSelected = selectedProjectId == projectWithCount.project.id.uuidString
        return Button {
            selectedProjectId = projectWithCount.project.id.uuidString
            selectedSmartFilter = .all
        } label: {
            HStack(spacing: Spacing.sm) {
                Circle()
                    .fill(Color(hex: projectWithCount.project.color) ?? .blue)
                    .frame(width: 8, height: 8)
                Text(projectWithCount.project.name)
                    .font(.body)
                Spacer()
                Text("\(projectWithCount.noteCount)")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, Spacing.xs + 2)
            .background(
                RoundedRectangle(cornerRadius: Radius.sm)
                    .fill(isSelected ? Color.accentColor.opacity(0.12) : Color.clear)
                    .padding(.horizontal, Spacing.sm)
            )
            .foregroundStyle(isSelected ? Color.accentColor : .primary)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Edit Description") {
                editingProject = projectWithCount.project
                editingDescription = projectWithCount.project.projectDescription ?? ""
            }
            Button("Delete", role: .destructive) {
                projectsViewModel.deleteProject(projectWithCount.project as CDProject)
            }
        }
        .help(projectWithCount.project.projectDescription ?? "")
    }
}
