import Foundation
import SwiftUI

enum ViewMode: String, CaseIterable, Identifiable {
    case feed = "Feed"
    case kanban = "Kanban"
    case calendar = "Calendar"
    case projectGroups = "Projects"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .feed: return "list.bullet"
        case .kanban: return "rectangle.split.3x1"
        case .calendar: return "calendar"
        case .projectGroups: return "folder"
        }
    }
}

@Observable
final class AppState {
    var currentViewMode: ViewMode = .feed
    var selectedProjectId: String?
}
