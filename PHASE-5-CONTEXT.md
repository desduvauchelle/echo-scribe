# Phase 5: Polish & Advanced Features

## Goal
Final polish: note editing, task completion, undo AI assignments, menu bar mode, export, Spotlight integration, keyboard navigation.

## What needs to be done

### 1. Note editing
**New file: `EchoScribe/Views/Detail/NoteDetailView.swift`**
- Full note view with inline text editing for processedText
- Edit project assignment (dropdown)
- Edit/add/remove tags
- View and manage tasks

### 2. Task completion
- Checkbox on tasks in `NoteCardView` and `NoteDetailView`
- Calls `AppDatabase.toggleTaskCompletion(id:)`
- Strikethrough completed tasks
- Filter by completed/incomplete in feed

### 3. Task editing
**New file: `EchoScribe/Views/Detail/TaskDetailView.swift`**
- Edit title, due date, project assignment
- Delete task

### 4. Undo AI assignments
- In NoteDetailView: button to reset project/tags to manual selection
- Override AI-suggested project with user's choice

### 5. Menu bar mode
- Optional menu bar presence (NSStatusItem)
- Click to toggle recording without opening full window
- Show recording indicator in menu bar

### 6. Export
- Markdown export per project or full database
- JSON export of all notes
- File save dialog

### 7. Spotlight integration
- Index notes via `CSSearchableIndex` (CoreSpotlight)
- Users can find notes from macOS Spotlight

### 8. Keyboard navigation
- Arrow keys in feed
- Enter to expand note detail
- Escape to close detail/overlay
- Tab between sidebar and feed

## Key existing files
- `EchoScribe/Views/Feed/NoteCardView.swift` — add task checkboxes
- `EchoScribe/Database/Queries/TaskQueries.swift` — `toggleTaskCompletion()`
- `EchoScribe/Database/Queries/NoteQueries.swift` — update operations
- `EchoScribe/Views/Detail/` — empty directory, create views here
