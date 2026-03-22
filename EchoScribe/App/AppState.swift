import Foundation
import SwiftUI

enum ViewMode: String, CaseIterable, Identifiable {
    case feed = "Feed"
    case kanban = "Kanban"
    case calendar = "Calendar"
    case projectGroups = "Projects"
    case settings = "Settings"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .feed: return "list.bullet"
        case .kanban: return "rectangle.split.3x1"
        case .calendar: return "calendar"
        case .projectGroups: return "folder"
        case .settings: return "gear"
        }
    }

    /// View modes shown in the main navigation picker (excludes settings)
    static var navigationModes: [ViewMode] {
        [.feed, .kanban, .calendar, .projectGroups]
    }
}

@Observable
final class AppState {
    var currentViewMode: ViewMode = .feed
    var selectedProjectId: String?
    var isSidebarVisible = false
    var isRecordingInline = false
}
