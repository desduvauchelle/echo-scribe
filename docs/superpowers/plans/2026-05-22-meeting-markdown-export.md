# Meeting Markdown Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Download Markdown" button to the meeting detail panel that saves the meeting as a `.md` file.

**Architecture:** A pure Rust builder (`meeting/export.rs`) turns a meeting's already-parsed data into a Markdown string and is unit-tested with `cargo test`. A Tauri command (`export_meeting_markdown`) loads the meeting + item, parses the stored JSON into the builder's minimal input structs, and returns the Markdown. A generic `write_text_file` command writes a chosen path. The React `MeetingExportButton` calls the command, opens the native Save dialog, and writes the file.

**Tech Stack:** Rust (Tauri v2 commands, serde_json), React + TypeScript, `@tauri-apps/plugin-dialog` (already installed).

---

## Reference: relevant existing code

- `src-tauri/src/db/meetings.rs:7` — `MeetingRow` (fields: `item_id`, `started_at`, `duration_ms`, `detected_app_name`, `transcript_json`, `summary_json`, `user_notes`, `calendar_match_json`, …).
- `src-tauri/src/meeting/synthesizer.rs:30` — `StoredSummary { summary: Vec<String>, action_items: Vec<ActionItem>, suggested_title: String, … }`; `ActionItem { text, owner, … }` at line 10.
- `src-tauri/src/meeting/mod.rs:29` — `Segment { speaker: Speaker, start_ms, end_ms, text }`; `Speaker::{You, Them}` enum just above. Transcript JSON shape is `{ "segments": [Segment], … }` (see `mod.rs:624`).
- `src-tauri/src/calendar/mod.rs:38` — `CalendarMatch { title, organizer: Option<Attendee>, attendees: Vec<Attendee>, … }`; `Attendee { name: Option<String>, email: Option<String>, self_: bool }` at line 22.
- `src-tauri/src/db/items.rs:133` — `get_item(conn, id) -> Option<Item>`; `Item.content` at `items.rs:65`.
- `src-tauri/src/commands.rs:2039` — `get_meeting` command (pattern for `state.db` + `with_conn`).
- `src-tauri/src/lib.rs:259-277` — meeting commands registered in `generate_handler!` with `commands::` prefix.
- `src/lib/api.ts:687` — `getMeeting` binding pattern; `invoke` imported at line 1. Multi-word Rust params map to camelCase JS keys (e.g. `session_id` ↔ `sessionId`, see `loadChatMessages` at `api.ts:364`).
- `src/components/ActivityPanel.tsx:706` — `MeetingView`; `ask` already imported from `@tauri-apps/plugin-dialog` at line 33; `useToasts` at line 36.

---

## File structure

- **Create** `src-tauri/src/meeting/export.rs` — pure Markdown builder + input structs + unit tests. One responsibility: data → Markdown string.
- **Modify** `src-tauri/src/meeting/mod.rs` — add `pub mod export;`.
- **Modify** `src-tauri/src/commands.rs` — add `export_meeting_markdown` + `write_text_file` commands.
- **Modify** `src-tauri/src/lib.rs` — register both commands.
- **Modify** `src/lib/api.ts` — add `exportMeetingMarkdown` + `writeTextFile` bindings.
- **Modify** `src/components/ActivityPanel.tsx` — add `MeetingExportButton`, render it in `MeetingView`.

---

## Task 1: Markdown builder module (Rust, pure + tested)

**Files:**
- Create: `src-tauri/src/meeting/export.rs`
- Modify: `src-tauri/src/meeting/mod.rs` (add module declaration)

- [ ] **Step 1: Declare the module**

In `src-tauri/src/meeting/mod.rs`, add this line alongside the other `pub mod` declarations (after `pub mod detector;` at line 7):

```rust
pub mod export;
```

- [ ] **Step 2: Write the builder + input types with failing tests**

Create `src-tauri/src/meeting/export.rs` with the full contents below. The `build_markdown` function and the test module are written together; the tests will fail to compile/run until the function exists, which is fine — Step 3 runs them.

```rust
//! Pure Markdown rendering of a meeting for file export.
//!
//! Takes minimal, already-parsed input structs (assembled by the
//! `export_meeting_markdown` command) and returns a Markdown document.
//! Kept dependency-free and side-effect-free so it can be unit-tested.

/// A calendar attendee or organizer, reduced to what the export needs.
pub struct AttendeeMd {
    pub name: Option<String>,
    pub email: Option<String>,
    pub is_self: bool,
}

/// One action item (owner + text).
pub struct ActionItemMd {
    pub owner: String,
    pub text: String,
}

/// One transcript line. `speaker_you` true => the user spoke.
pub struct SegmentMd {
    pub speaker_you: bool,
    pub text: String,
}

/// Everything the Markdown builder needs, already parsed out of the DB row.
pub struct MeetingMarkdownInput {
    pub title: String,
    /// RFC3339 start timestamp; only the `YYYY-MM-DD` prefix is used.
    pub started_at: String,
    pub duration_ms: Option<i64>,
    pub detected_app_name: Option<String>,
    pub organizer: Option<AttendeeMd>,
    pub attendees: Vec<AttendeeMd>,
    pub summary: Vec<String>,
    pub action_items: Vec<ActionItemMd>,
    pub user_notes: Option<String>,
    pub segments: Vec<SegmentMd>,
    /// Free-text item body, used as the Summary section when there are no
    /// summary bullets.
    pub fallback_content: Option<String>,
}

fn render_attendee(a: &AttendeeMd) -> String {
    let name = a.name.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let email = a.email.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let base = match (name, email) {
        (Some(n), Some(e)) => format!("{n} <{e}>"),
        (Some(n), None) => n.to_string(),
        (None, Some(e)) => e.to_string(),
        (None, None) => "?".to_string(),
    };
    if a.is_self {
        format!("{base} (you)")
    } else {
        base
    }
}

/// Render a meeting as a Markdown document. Sections with no data are omitted.
pub fn build_markdown(input: &MeetingMarkdownInput) -> String {
    let mut out = String::new();

    let title = input.title.trim();
    let title = if title.is_empty() { "Untitled meeting" } else { title };
    out.push_str(&format!("# {title}\n\n"));

    // Metadata line: date · N min · app  (omit absent parts).
    let mut meta: Vec<String> = Vec::new();
    if let Some(date) = input.started_at.get(0..10) {
        if !date.is_empty() {
            meta.push(date.to_string());
        }
    }
    if let Some(ms) = input.duration_ms {
        if ms > 0 {
            meta.push(format!("{} min", (ms / 60_000).max(1)));
        }
    }
    if let Some(app) = input.detected_app_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        meta.push(app.to_string());
    }
    if !meta.is_empty() {
        out.push_str(&format!("*{}*\n\n", meta.join(" · ")));
    }

    // Organizer + attendees.
    if let Some(org) = &input.organizer {
        out.push_str(&format!("**Organizer:** {}\n\n", render_attendee(org)));
    }
    if !input.attendees.is_empty() {
        let names: Vec<String> = input.attendees.iter().map(render_attendee).collect();
        out.push_str(&format!("**Attendees:** {}\n\n", names.join(", ")));
    }

    // Summary (bullets), else fall back to free-text content.
    if !input.summary.is_empty() {
        out.push_str("## Summary\n\n");
        for b in &input.summary {
            out.push_str(&format!("- {}\n", b.trim()));
        }
        out.push('\n');
    } else if let Some(c) = input.fallback_content.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        out.push_str("## Summary\n\n");
        out.push_str(c);
        out.push_str("\n\n");
    }

    // Action items.
    if !input.action_items.is_empty() {
        out.push_str("## Action Items\n\n");
        for a in &input.action_items {
            out.push_str(&format!("- ({}) {}\n", a.owner.trim(), a.text.trim()));
        }
        out.push('\n');
    }

    // Notes.
    if let Some(n) = input.user_notes.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        out.push_str("## Notes\n\n");
        out.push_str(n);
        out.push_str("\n\n");
    }

    // Transcript.
    if !input.segments.is_empty() {
        out.push_str("## Transcript\n\n");
        for s in &input.segments {
            let who = if s.speaker_you { "You" } else { "Them" };
            out.push_str(&format!("**{}:** {}\n\n", who, s.text.trim()));
        }
    }

    format!("{}\n", out.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full_input() -> MeetingMarkdownInput {
        MeetingMarkdownInput {
            title: "Weekly Sync".to_string(),
            started_at: "2026-05-22T15:04:05Z".to_string(),
            duration_ms: Some(30 * 60_000),
            detected_app_name: Some("zoom.us".to_string()),
            organizer: Some(AttendeeMd {
                name: Some("Alice".to_string()),
                email: Some("alice@example.com".to_string()),
                is_self: false,
            }),
            attendees: vec![
                AttendeeMd { name: Some("Alice".to_string()), email: None, is_self: false },
                AttendeeMd { name: Some("Me".to_string()), email: None, is_self: true },
            ],
            summary: vec!["Shipped v1".to_string(), "Planned v2".to_string()],
            action_items: vec![ActionItemMd {
                owner: "you".to_string(),
                text: "Write the spec".to_string(),
            }],
            user_notes: Some("Remember to follow up.".to_string()),
            segments: vec![
                SegmentMd { speaker_you: true, text: "Hello".to_string() },
                SegmentMd { speaker_you: false, text: "Hi there".to_string() },
            ],
            fallback_content: Some("ignored when summary present".to_string()),
        }
    }

    #[test]
    fn full_meeting_renders_all_sections() {
        let md = build_markdown(&full_input());
        assert!(md.starts_with("# Weekly Sync\n"));
        assert!(md.contains("*2026-05-22 · 30 min · zoom.us*"));
        assert!(md.contains("**Organizer:** Alice <alice@example.com>"));
        assert!(md.contains("**Attendees:** Alice, Me (you)"));
        assert!(md.contains("## Summary\n\n- Shipped v1\n- Planned v2"));
        assert!(md.contains("## Action Items\n\n- (you) Write the spec"));
        assert!(md.contains("## Notes\n\nRemember to follow up."));
        assert!(md.contains("## Transcript\n\n**You:** Hello\n\n**Them:** Hi there"));
        assert!(md.ends_with('\n'));
        // fallback content must NOT appear when summary bullets exist
        assert!(!md.contains("ignored when summary present"));
    }

    #[test]
    fn empty_sections_are_omitted() {
        let input = MeetingMarkdownInput {
            title: "  ".to_string(),
            started_at: "".to_string(),
            duration_ms: None,
            detected_app_name: None,
            organizer: None,
            attendees: vec![],
            summary: vec![],
            action_items: vec![],
            user_notes: None,
            segments: vec![],
            fallback_content: None,
        };
        let md = build_markdown(&input);
        assert_eq!(md, "# Untitled meeting\n");
    }

    #[test]
    fn fallback_content_used_when_no_summary_bullets() {
        let mut input = full_input();
        input.summary = vec![];
        input.fallback_content = Some("Free text recap".to_string());
        let md = build_markdown(&input);
        assert!(md.contains("## Summary\n\nFree text recap"));
    }

    #[test]
    fn attendee_email_only_and_self_flag() {
        let a = AttendeeMd { name: None, email: Some("x@y.z".to_string()), is_self: true };
        assert_eq!(render_attendee(&a), "x@y.z (you)");
        let b = AttendeeMd { name: None, email: None, is_self: false };
        assert_eq!(render_attendee(&b), "?");
    }
}
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test --lib export::tests`
Expected: 4 tests pass (`full_meeting_renders_all_sections`, `empty_sections_are_omitted`, `fallback_content_used_when_no_summary_bullets`, `attendee_email_only_and_self_flag`).

- [ ] **Step 4: Commit**

```bash
cd /Users/denisduvauchelle/Documents/code/echo-scribe
git add src-tauri/src/meeting/export.rs src-tauri/src/meeting/mod.rs
git commit -m "feat(meeting): pure Markdown builder for meeting export

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Tauri commands (`export_meeting_markdown` + `write_text_file`)

**Files:**
- Modify: `src-tauri/src/commands.rs` (add two commands; place after `get_meeting` at line ~2047)
- Modify: `src-tauri/src/lib.rs` (register both, near line 277)

- [ ] **Step 1: Add the commands**

In `src-tauri/src/commands.rs`, immediately after the `get_meeting` command (ends at line ~2047), add:

```rust
/// Map a calendar attendee to the export builder's minimal struct.
fn attendee_to_md(a: &crate::calendar::Attendee) -> crate::meeting::export::AttendeeMd {
    crate::meeting::export::AttendeeMd {
        name: a.name.clone(),
        email: a.email.clone(),
        is_self: a.self_,
    }
}

#[tauri::command]
pub fn export_meeting_markdown(
    state: tauri::State<'_, AppState>,
    item_id: String,
) -> Result<String, String> {
    use crate::meeting::export::{ActionItemMd, MeetingMarkdownInput, SegmentMd};

    let db = state.db.as_ref().ok_or("db unavailable")?;
    let id = item_id.clone();
    let (meeting, item) = db
        .with_conn(move |conn| {
            let m = crate::db::meetings::get_meeting(conn, &id)?;
            let it = crate::db::items::get_item(conn, &id)?;
            Ok((m, it))
        })
        .map_err(|e| e.to_string())?;

    let meeting = meeting.ok_or("meeting not found")?;
    let item = item.ok_or("item not found")?;

    // Summary (suggested title, bullets, action items).
    let summary: Option<crate::meeting::synthesizer::StoredSummary> = meeting
        .summary_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());

    let title = summary
        .as_ref()
        .map(|s| s.suggested_title.clone())
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| {
            item.content
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string()
        });

    let (summary_bullets, action_items): (Vec<String>, Vec<ActionItemMd>) = match &summary {
        Some(s) => (
            s.summary.clone(),
            s.action_items
                .iter()
                .map(|a| ActionItemMd {
                    owner: a.owner.clone(),
                    text: a.text.clone(),
                })
                .collect(),
        ),
        None => (Vec::new(), Vec::new()),
    };

    // Transcript segments (parsed from the `{ "segments": [...] }` JSON).
    let segments: Vec<SegmentMd> = meeting
        .transcript_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v.get("segments").cloned())
        .and_then(|segs| serde_json::from_value::<Vec<crate::meeting::Segment>>(segs).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|seg| SegmentMd {
            speaker_you: matches!(seg.speaker, crate::meeting::Speaker::You),
            text: seg.text,
        })
        .collect();

    // Calendar match (organizer + attendees).
    let calendar: Option<crate::calendar::CalendarMatch> = meeting
        .calendar_match_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());
    let (organizer, attendees) = match &calendar {
        Some(c) => (
            c.organizer.as_ref().map(attendee_to_md),
            c.attendees.iter().map(attendee_to_md).collect(),
        ),
        None => (None, Vec::new()),
    };

    let input = MeetingMarkdownInput {
        title,
        started_at: meeting.started_at,
        duration_ms: meeting.duration_ms,
        detected_app_name: meeting.detected_app_name,
        organizer,
        attendees,
        summary: summary_bullets,
        action_items,
        user_notes: meeting.user_notes,
        segments,
        fallback_content: Some(item.content),
    };

    Ok(crate::meeting::export::build_markdown(&input))
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register both commands**

In `src-tauri/src/lib.rs`, after `commands::match_meeting_calendar,` (line ~277) add:

```rust
            commands::export_meeting_markdown,
            commands::write_text_file,
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: compiles with no errors. (Warnings about unused imports elsewhere are pre-existing and acceptable.)

- [ ] **Step 4: Commit**

```bash
cd /Users/denisduvauchelle/Documents/code/echo-scribe
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(meeting): export_meeting_markdown + write_text_file commands

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Frontend bindings (`api.ts`)

**Files:**
- Modify: `src/lib/api.ts` (add after `renameMeeting` at line ~693)

- [ ] **Step 1: Add the two bindings**

In `src/lib/api.ts`, after the `renameMeeting` binding (line ~693), add:

```ts
export const exportMeetingMarkdown = (itemId: string): Promise<string> =>
  invoke("export_meeting_markdown", { itemId });
export const writeTextFile = (path: string, contents: string): Promise<void> =>
  invoke("write_text_file", { path, contents });
```

- [ ] **Step 2: Verify types compile**

Run: `bun run tsc --noEmit` (or `bunx tsc --noEmit` if that fails)
Expected: no new type errors referencing `api.ts`.

- [ ] **Step 3: Commit**

```bash
cd /Users/denisduvauchelle/Documents/code/echo-scribe
git add src/lib/api.ts
git commit -m "feat(meeting): api bindings for markdown export

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `MeetingExportButton` component + wiring into `MeetingView`

**Files:**
- Modify: `src/components/ActivityPanel.tsx`

- [ ] **Step 1: Extend imports**

In `src/components/ActivityPanel.tsx`, add `Download` to the lucide import (line 2). Change:

```tsx
import { Copy, Eye, Pencil, RotateCcw, Trash2, X } from "lucide-react";
```

to:

```tsx
import { Copy, Download, Eye, Pencil, RotateCcw, Trash2, X } from "lucide-react";
```

Add `save` to the existing plugin-dialog import (line 33). Change:

```tsx
import { ask } from "@tauri-apps/plugin-dialog";
```

to:

```tsx
import { ask, save } from "@tauri-apps/plugin-dialog";
```

Add the two API functions to the existing `../lib/api` import block (the block spanning lines 4-32). Add these names alongside the other imports (e.g. after `deleteMeeting,`):

```tsx
  exportMeetingMarkdown,
  writeTextFile,
```

- [ ] **Step 2: Add the `MeetingExportButton` component**

In `src/components/ActivityPanel.tsx`, add this component immediately before the `MeetingView` function (before line 706). It uses `useToasts` directly (the provider wraps the app):

```tsx
function MeetingExportButton({
  item,
  meeting,
}: {
  item: Item;
  meeting: MeetingRow;
}) {
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);

  const onDownload = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const md = await exportMeetingMarkdown(item.id);

      // Default filename: "YYYY-MM-DD Title.md", filesystem-safe.
      const summary = meeting.summary_json
        ? safeParseSummary(meeting.summary_json)
        : null;
      const rawTitle =
        summary?.suggested_title?.trim() ||
        item.content.split("\n")[0]?.trim() ||
        "Untitled meeting";
      const safeTitle = rawTitle.replace(/[/\\?%*:|"<>]/g, "-").slice(0, 80);
      const date = meeting.started_at.slice(0, 10);
      const defaultName = `${date} ${safeTitle}.md`;

      const path = await save({
        defaultPath: defaultName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return; // user cancelled

      await writeTextFile(path, md);
      toasts.push({ tone: "success", message: "Meeting exported." });
    } catch (e) {
      toasts.push({
        tone: "error",
        message: `Export failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void onDownload()}
      disabled={busy}
      className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:bg-elevated hover:text-fg disabled:opacity-50"
    >
      <Download size={12} strokeWidth={2} />
      {busy ? "Exporting…" : "Download Markdown"}
    </button>
  );
}
```

- [ ] **Step 3: Render the button in `MeetingView`**

In `src/components/ActivityPanel.tsx`, inside `MeetingView`'s returned JSX, place the button right after the metadata badges block. The badges block is the `<div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">…</div>` that ends just before `<ProjectSection`. Insert immediately after that closing `</div>`:

```tsx
      <div>
        <MeetingExportButton item={item} meeting={meeting} />
      </div>
```

- [ ] **Step 4: Verify it compiles**

Run: `bun run tsc --noEmit` (or `bunx tsc --noEmit`)
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/denisduvauchelle/Documents/code/echo-scribe
git add src/components/ActivityPanel.tsx
git commit -m "feat(meeting): Download Markdown button in meeting detail panel

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Build, install, and manual verification

**Files:** none (build + manual test)

- [ ] **Step 1: Run the full Rust test suite**

Run: `cd src-tauri && cargo test --lib && cd ..`
Expected: all tests pass, including the four `export::tests`.

- [ ] **Step 2: Build the release bundle**

Run: `bun tauri build --bundles app`
Expected: build succeeds, producing `src-tauri/target/release/bundle/macos/Echo Scribe.app`.

- [ ] **Step 3: Skip-TCC reinstall**

No permission-related code changed (no Info.plist / entitlements / capabilities changes), so use the default skip-TCC reinstall:

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

- [ ] **Step 4: Manual verification (the human does this)**

1. Open Echo Scribe, go to **Meetings**, click a completed meeting to open the detail panel.
2. Confirm a **Download Markdown** button appears under the meeting metadata badges.
3. Click it → native Save dialog appears with a default name `YYYY-MM-DD <title>.md`.
4. Save, then open the `.md` file. Confirm it contains the title, metadata line, and the present sections (Summary, Action Items, Notes, Attendees, Transcript) with correct content, and that empty sections are absent.
5. Click Download again and **Cancel** the Save dialog → no error toast, nothing written.

---

## Self-review notes

- **Spec coverage:** Button in meeting detail (Task 4) ✓; native Save dialog (Task 4) ✓; all content sections — title/date/duration/app, summary, action items, notes, attendees/organizer, transcript (Task 1 builder + Task 2 command) ✓; skip-empty-sections (Task 1) ✓; Rust unit tests (Task 1) ✓; `export_meeting_markdown` + `write_text_file` commands (Task 2) ✓; api bindings (Task 3) ✓; error toasts + cancel-is-noop (Task 4) ✓; no new TCC/capabilities (Task 5 Step 3) ✓.
- **Type consistency:** `MeetingMarkdownInput`, `AttendeeMd`, `ActionItemMd`, `SegmentMd`, `build_markdown` defined in Task 1 and used identically in Task 2. Command names `export_meeting_markdown` / `write_text_file` consistent across Tasks 2-4. JS bindings `exportMeetingMarkdown` / `writeTextFile` consistent across Tasks 3-4. `safeParseSummary` reused from existing `ActivityPanel.tsx` (already in that file).
- **Deferred (out of scope, per spec):** Word/`.docx`, Google Drive, split-button dropdown.
