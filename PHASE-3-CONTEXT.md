# Phase 3: Filtering, Organization & Visualizations

## Goal
Add full filtering UI and alternative views: kanban board, calendar view, and project-grouped view. Users can filter by project, tags, date range, and content type, and switch between 4 visualization modes.

## Current State (after Phase 2)
- App records voice, transcribes, and AI-enriches notes with projects/tags/tasks
- Feed view shows chronological notes with project badges, tags, task chips
- Sidebar lists projects with note counts
- Basic search bar exists in `FilterBarView`
- `FeedViewModel` already has filter properties: `selectedProjectId`, `selectedTags`, `searchText`, `dateRange`
- `AppState.swift` defines `ViewMode` enum: `.feed`, `.kanban`, `.calendar`, `.projectGroups`
- `NoteQueries.swift` has `fetchAllNotesWithDetails(projectId:, tagIds:, searchText:, dateRange:)` ready
- `TaskQueries.swift` has `fetchTasksDueToday()` and `fetchTasks(projectId:, isCompleted:, dueBefore:)` ready

## Tech Stack
- Swift 6.0 / macOS 15+ / SwiftUI
- GRDB.swift 7.10 for SQLite
- All ViewModels are `@MainActor @Observable`
- Xcode project via xcodegen (`project.yml`)

## What needs to be done

### 1. Enhance FilterBarView
**File: `EchoScribe/Views/Feed/FilterBarView.swift`**

Currently just a search field. Add:
- **Project filter**: Dropdown/popover to select a project
- **Tag filter**: Multi-select popover for tags
- **Date range**: Date picker popover (start/end)
- **Content type**: Segmented control (All / Notes / Tasks)
- Active filters shown as dismissable chips

Needs a new `FilterViewModel` or extend existing filter properties on `FeedViewModel`.

### 2. Enhance SidebarView with smart filters
**File: `EchoScribe/Views/MainWindow/SidebarView.swift`**

Add a "Smart Filters" section above Projects:
- "Today's Tasks" — uses `fetchTasksDueToday()`
- "Recent" — last 7 days
- "Unprocessed" — notes where `isProcessed == false`

### 3. Add view switcher to toolbar
**File: `EchoScribe/Views/MainWindow/ContentView.swift`**

Add a segmented picker or toolbar buttons to switch between `ViewMode` cases.
Store the active mode in `AppState` or as `@State` in ContentView.
Swap the detail view based on selected mode.

### 4. Create KanbanView
**New file: `EchoScribe/Views/Visualizations/KanbanView.swift`**

- Horizontal scroll of columns, one per project (+ "Unassigned")
- Each column is a vertical list of `NoteCardView`s
- Drag-and-drop to reassign notes between projects (`.draggable` / `.dropDestination`)
- Column headers show project name + note count

### 5. Create CalendarView
**New file: `EchoScribe/Views/Visualizations/CalendarView.swift`**

- Month grid view
- Each day cell shows a count badge (notes + tasks)
- Tasks with due dates appear as colored dots
- Clicking a day filters the feed to that date
- Navigation: previous/next month arrows

### 6. Create ProjectGroupView
**New file: `EchoScribe/Views/Visualizations/ProjectGroupView.swift`**

- Vertical scrolling list
- `DisclosureGroup` per project (collapsible)
- Notes listed under their project
- "Unassigned" section for notes without a project

### 7. Wire up detail view switching
**File: `EchoScribe/Views/MainWindow/ContentView.swift`**

```swift
// In the detail area, switch based on viewMode:
switch appState.currentViewMode {
case .feed: FeedView(...)
case .kanban: KanbanView(...)
case .calendar: CalendarView(...)
case .projectGroups: ProjectGroupView(...)
}
```

All views should respect the same filter state from `FeedViewModel`.

## Key existing files to read before starting
- `EchoScribe/Views/MainWindow/ContentView.swift` — root layout, add view switcher here
- `EchoScribe/Views/MainWindow/SidebarView.swift` — add smart filters
- `EchoScribe/Views/Feed/FilterBarView.swift` — enhance with filter popovers
- `EchoScribe/Views/Feed/FeedView.swift` — reference for how notes are displayed
- `EchoScribe/Views/Feed/NoteCardView.swift` — reuse in all views
- `EchoScribe/ViewModels/FeedViewModel.swift` — filter state + data fetching
- `EchoScribe/App/AppState.swift` — `ViewMode` enum already defined
- `EchoScribe/Database/Queries/NoteQueries.swift` — filtering queries ready
- `EchoScribe/Database/Queries/TaskQueries.swift` — task queries ready

## Key types
- `ViewMode` enum: `.feed`, `.kanban`, `.calendar`, `.projectGroups` (in AppState.swift)
- `NoteWithDetails` — `{ note, project, tasks, tags }` (in NoteQueries.swift)
- `ProjectWithCount` — `{ project, noteCount }` (in ProjectQueries.swift)
- `FeedViewModel` — has `notes: [NoteWithDetails]`, filter properties, `startObservation()`
- `FlowLayout` — custom Layout for tag chips (in NoteCardView.swift)

## Empty view directories already created
- `EchoScribe/Views/Visualizations/` — put KanbanView, CalendarView, ProjectGroupView here
- `EchoScribe/Views/Detail/` — for NoteDetailView, TaskDetailView (Phase 5)
- `EchoScribe/Views/Settings/` — for SettingsView (Phase 2/4)

## Build & verify
1. `xcodegen generate` if project.yml changed
2. Open `EchoScribe.xcodeproj`, build (Cmd+B)
3. Run app with some existing notes
4. Test: switch between feed/kanban/calendar/project views
5. Test: apply filters (project, search, tags) and verify they persist across view switches
6. Test: drag a note between kanban columns to reassign project
7. Test: click a calendar day to filter
