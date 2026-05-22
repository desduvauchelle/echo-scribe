# Meeting Markdown Export — Design

**Date:** 2026-05-22
**Status:** Approved (design), pending implementation plan

## Goal

Add a button to the meeting detail view that downloads the meeting as a
Markdown file. Markdown is the only format in this phase; Word/`.docx` and
Google Drive are explicitly deferred to their own later phases, but the code is
structured so adding them is a localized change.

## Scope

### In scope (this phase)

- A single "Download Markdown" button in the meeting detail panel.
- A native Save dialog to choose the destination path and filename.
- A Markdown document containing every section that has data:
  - Title + date + duration + detected app.
  - Summary bullets.
  - Action items (owner + text).
  - Personal notes.
  - Calendar attendees / organizer.
  - Full transcript.
- Cargo unit tests for the Markdown builder.

### Out of scope (future phases, separate specs)

- Word / `.docx` export.
- Google Drive (or any cloud) upload — requires OAuth + network and cuts
  against the app's local-only privacy model.
- A multi-format split-button dropdown UI. With one format it would be a
  dropdown of one item, so it is omitted now. The export button is isolated in
  its own component so it can become a split button when a second format lands.

## Architecture

The Markdown is built in **Rust**, not the frontend, for two reasons:

1. Rust already owns the serde structs that produced the stored JSON
   (`StoredSummary`, `ActionItem` in `src/meeting/synthesizer.rs`; `Segment` /
   transcript in `src/meeting/mod.rs` + `src/meeting/pipeline.rs`;
   `CalendarMatch` / `Attendee` in `src/calendar/mod.rs`). Building in Rust
   reuses these instead of re-parsing JSON in TypeScript.
2. The project has a Rust test runner (`cargo test`) and **no** JS test runner.
   A Rust builder gets real unit-test coverage; a TS builder would not.

### Components

**1. `src-tauri/src/meeting/export.rs` (new)**

A pure builder function plus its tests:

```rust
pub fn build_markdown(input: &MeetingMarkdownInput) -> String
```

`MeetingMarkdownInput` is a plain struct assembled by the command from already
loaded/parsed data (title, started_at, duration_ms, detected_app_name, summary
bullets, action items, user notes, calendar match, transcript segments,
fallback item content). The function:

- Emits `# {title}` (falls back to "Untitled meeting").
- Emits an italic metadata line: date, `{n} min`, detected app — omitting parts
  that are absent.
- Emits `**Attendees:**` / organizer line when a calendar match is present
  (organizer flagged, `(you)` flagged via `self_`).
- Emits `## Summary`, `## Action Items`, `## Notes`, `## Transcript` sections,
  **skipping any section with no data**.
- Action items render as `- (owner) text`.
- Transcript renders one line per segment: `**you:** …` / `**them:** …`.
- When there are no summary bullets but the item has free-text content, falls
  back to emitting that content under `## Summary`.

This function is deterministic and is the unit-test target.

**2. `export_meeting_markdown` command (new, in `src/commands.rs`)**

```rust
#[tauri::command]
pub fn export_meeting_markdown(item_id: String, /* state */) -> Result<String, String>
```

Loads the meeting (via the existing `get_meeting` path) plus the item content,
parses `summary_json` / `transcript_json` / calendar match into the builder
input, calls `build_markdown`, and returns the Markdown string. Returning the
string (rather than writing directly) keeps the command reusable for a future
"copy to clipboard" or Word path.

**3. `write_text_file` command (new, generic, in `src/commands.rs`)**

```rust
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String>
```

Thin wrapper over `std::fs::write`, mapping IO errors to `String`. Generic so it
can be reused by other future exports.

Both commands are registered in the `invoke_handler!` list in `src/lib.rs`.

**4. Frontend bindings (`src/lib/api.ts`)**

```ts
export function exportMeetingMarkdown(itemId: string): Promise<string>
export function writeTextFile(path: string, contents: string): Promise<void>
```

**5. `MeetingExportButton` component (new, used inside `MeetingView` in
`src/components/ActivityPanel.tsx`)**

- Renders a `Download` (lucide) icon + "Download Markdown".
- Lives inside `MeetingView` (meeting-specific), not the shared
  `ActionsSection`.
- On click:
  1. `const md = await exportMeetingMarkdown(item.id)`.
  2. `const path = await save({ defaultPath, filters: [{ name: "Markdown", extensions: ["md"] }] })`
     using the existing `@tauri-apps/plugin-dialog` (`dialog:default` already
     grants `save`).
  3. If `path` is null (user cancelled) → no-op.
  4. `await writeTextFile(path, md)`.
  5. Success → success toast; failure → error toast (`useToasts`, already in
     the panel).
- `defaultPath` filename: `YYYY-MM-DD Title.md`, where `Title` is the meeting
  title with filesystem-unsafe characters stripped, falling back to
  "Untitled meeting".

## Data flow

```
MeetingExportButton click
  → invoke export_meeting_markdown(item_id)        [Rust: load + parse + build_markdown]
  → returns Markdown string
  → dialog.save(defaultPath, .md filter)           [native Save panel]
  → invoke write_text_file(path, markdown)          [Rust: std::fs::write]
  → toast (success | error)
```

## Error handling

- `export_meeting_markdown` returns `Err(String)` if the meeting/item can't be
  loaded; surfaced as an error toast.
- User cancelling the Save dialog is a normal no-op, not an error.
- `write_text_file` IO failure → error toast with the message.

## Testing

- **Rust unit tests** in `export.rs` covering: full meeting (all sections),
  meeting with only a summary, empty/sparse meeting (sections skipped),
  attendee/organizer rendering with `self_`, and the item-content fallback.
- **Manual verification**: run the app, open a completed meeting, click
  Download Markdown, confirm the saved `.md` opens with correct sections.

## Files touched

- `src-tauri/src/meeting/export.rs` — new.
- `src-tauri/src/meeting/mod.rs` — `pub mod export;`.
- `src-tauri/src/commands.rs` — `export_meeting_markdown`, `write_text_file`.
- `src-tauri/src/lib.rs` — register both commands.
- `src/lib/api.ts` — two bindings.
- `src/components/ActivityPanel.tsx` — `MeetingExportButton` in `MeetingView`.

## Permissions / TCC

No new TCC-relevant changes: no new Info.plist usage descriptions, no new
entitlements, no new capabilities (the `dialog:default` capability already
grants `save`). `std::fs::write` to a user-chosen path needs no extra grant.
A standard skip-TCC reinstall applies.
