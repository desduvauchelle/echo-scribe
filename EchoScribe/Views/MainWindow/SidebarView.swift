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

    var body: some View {
        List {
            Section("Smart Filters") {
                ForEach([SmartFilter.all, .todaysTasks, .recent, .unprocessed]) { filter in
                    Button {
                        selectedSmartFilter = filter
                        selectedProjectId = nil
                    } label: {
                        Label(filter.label, systemImage: filter.icon)
                            .foregroundStyle(selectedSmartFilter == filter && selectedProjectId == nil ? .accentColor : .primary)
                    }
                    .buttonStyle(.plain)
                }
            }

            Section("Projects") {
                ForEach(projectsViewModel.projects, id: \.project.id) { projectWithCount in
                    Button {
                        selectedProjectId = projectWithCount.project.id
                        selectedSmartFilter = .all
                    } label: {
                        HStack {
                            Circle()
                                .fill(Color(hex: projectWithCount.project.color) ?? .blue)
                                .frame(width: 8, height: 8)
                            Text(projectWithCount.project.name)
                                .foregroundStyle(selectedProjectId == projectWithCount.project.id ? .accentColor : .primary)
                            Spacer()
                            Text("\(projectWithCount.noteCount)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(.quaternary, in: Capsule())
                        }
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button("Delete", role: .destructive) {
                            projectsViewModel.deleteProject(projectWithCount.project)
                        }
                    }
                }

                Button {
                    showNewProjectSheet = true
                } label: {
                    Label("New Project", systemImage: "plus")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Echo Scribe")
        .sheet(isPresented: $showNewProjectSheet) {
            VStack(spacing: 16) {
                Text("New Project").font(.headline)
                TextField("Project name", text: $newProjectName)
                    .textFieldStyle(.roundedBorder)
                HStack {
                    Button("Cancel") {
                        newProjectName = ""
                        showNewProjectSheet = false
                    }
                    Spacer()
                    Button("Create") {
                        if !newProjectName.isEmpty {
                            projectsViewModel.createProject(name: newProjectName)
                            newProjectName = ""
                            showNewProjectSheet = false
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(newProjectName.isEmpty)
                }
            }
            .padding()
            .frame(width: 300)
        }
    }
}
