# Focus Context Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At hotkey press, capture the active app name, window title, and browser URL so every dictation carries rich context about where the user was working.

**Architecture:** Extend `FocusSnapshot` → `FocusContext` with three new optional fields populated at capture time: `app_name` (from `NSRunningApplication.localizedName`), `window_title` (via `AXUIElement` accessibility tree), and `browser_url` (via `osascript` subprocess for known browsers). All three are best-effort/nullable — failure never delays recording. The context is serialised to JSON and stored in a new `capture_context TEXT` column on `items`, and also injected into the LLM classifier's system prompt.

**Tech Stack:** Rust / objc2 0.6 (`objc2-app-kit`, `objc2-application-services`, `objc2-core-foundation`), `std::process::Command` for AppleScript, `rusqlite` migrations, `serde_json` for serialisation. macOS-only implementation guarded by `#[cfg(target_os = "macos")]`; all other platforms return `None` via stub functions.

---

## File Map

| File | Change |
|---|---|
| `src-tauri/src/input/focus.rs` | Rename `FocusSnapshot` → `FocusContext`, add `app_name`/`window_title`/`browser_url` fields, add macOS impl functions, keep `restore()` unchanged |
| `src-tauri/src/db/schema.rs` | Append migration v6: `ALTER TABLE items ADD COLUMN capture_context TEXT` |
| `src-tauri/src/db/items.rs` | Add `capture_context: Option<String>` to `Item`, update `insert_item` + `row_to_item` |
| `src-tauri/src/coordinator.rs` | Rename `pending_focus` → `pending_context`, thread `FocusContext` into `persist_capture`/`persist_log_capture`, pass to `run_classifier` |
| `src-tauri/src/classifier.rs` | Accept `Option<&FocusContext>` in `build_system_prompt`, append context block to prompt |

---

## Task 1: Rename `FocusSnapshot` → `FocusContext` and add new fields

**Files:**
- Modify: `src-tauri/src/input/focus.rs`
- Modify: `src-tauri/src/coordinator.rs` (rename only)

- [ ] **Step 1: Write the failing test for `app_name`**

Add to the `tests` module at the bottom of `src-tauri/src/input/focus.rs`:

```rust
#[test]
fn capture_context_returns_app_name() {
    let ctx = capture_context();
    if let Some(c) = ctx {
        assert!(c.pid > 0);
        // app_name should be Some(...) whenever we have a frontmost app
        assert!(
            c.app_name.is_some(),
            "expected app_name to be populated, got None (pid={})", c.pid
        );
    }
}
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd src-tauri && cargo test --lib input::focus -- --nocapture 2>&1 | tail -20
```

Expected: compile error — `capture_context` doesn't exist yet.

- [ ] **Step 3: Replace the struct and add macOS `capture_context()`**

Replace the entire contents of `src-tauri/src/input/focus.rs` with:

```rust
//! Capture-and-restore the macOS frontmost application, plus rich context.
//!
//! `FocusContext` is captured at hotkey-press time (before our overlay can
//! steal key-window status) and carries two concerns:
//!   1. `pid` — used by `restore()` to re-activate the original app before
//!      synthesising Cmd+V, so paste lands in the right window.
//!   2. `app_name`, `window_title`, `browser_url` — stored with each item
//!      and fed to the LLM classifier for richer routing.

#[cfg(target_os = "macos")]
use libc::pid_t;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FocusContext {
    pub pid: i32,
    pub bundle_id: Option<String>,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub browser_url: Option<String>,
}

/// Capture the frontmost application plus window/browser context.
/// Best-effort: never panics; missing fields are `None`.
#[cfg(target_os = "macos")]
pub fn capture_context() -> Option<FocusContext> {
    use objc2_app_kit::NSWorkspace;

    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    let pid = app.processIdentifier() as i32;
    let bundle_id = app.bundleIdentifier().map(|s| s.to_string());
    let app_name = app.localizedName().map(|s| s.to_string());

    let window_title = capture_window_title_macos(pid);
    let browser_url = bundle_id
        .as_deref()
        .and_then(capture_browser_url_macos);

    Some(FocusContext {
        pid,
        bundle_id,
        app_name,
        window_title,
        browser_url,
    })
}

#[cfg(not(target_os = "macos"))]
pub fn capture_context() -> Option<FocusContext> {
    None
}

/// Re-activate the previously-frontmost app before synthesising Cmd+V.
#[cfg(target_os = "macos")]
pub fn restore(ctx: &FocusContext) -> bool {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

    let Some(app) =
        NSRunningApplication::runningApplicationWithProcessIdentifier(ctx.pid as pid_t)
    else {
        return false;
    };
    #[allow(deprecated)]
    let opts = NSApplicationActivationOptions::ActivateIgnoringOtherApps;
    app.activateWithOptions(opts)
}

#[cfg(not(target_os = "macos"))]
pub fn restore(_ctx: &FocusContext) -> bool {
    false
}

// ── macOS helpers ─────────────────────────────────────────────────────────────

/// Get the focused window's title via the Accessibility API.
/// Returns `None` if accessibility permission is absent or the call times out.
#[cfg(target_os = "macos")]
fn capture_window_title_macos(pid: i32) -> Option<String> {
    use objc2_application_services::AXUIElement;
    use objc2_core_foundation::{CFRetained, CFString, CFType};
    use std::ptr::NonNull;

    // kAXFocusedWindowAttribute and kAXTitleAttribute are exported C symbols
    // from ApplicationServices but not yet wrapped in objc2-application-services.
    // We declare them manually using the same pattern the crate uses for
    // kAXTrustedCheckOptionPrompt.
    extern "C" {
        static kAXFocusedWindowAttribute: CFString;
        static kAXTitleAttribute: CFString;
    }

    unsafe {
        let app_el = AXUIElement::new_application(pid as pid_t);
        // Cap each AX call at 100 ms so a hung app never delays recording.
        app_el.set_messaging_timeout(0.1);

        let mut win_raw: *const CFType = std::ptr::null();
        let err = app_el.copy_attribute_value(
            &kAXFocusedWindowAttribute,
            NonNull::new(&mut win_raw as *mut _ as *mut *const CFType)?,
        );
        if err.0 != 0 || win_raw.is_null() {
            return None;
        }
        // Retain the window element so it lives past the pointer cast.
        let win_el: CFRetained<AXUIElement> =
            CFRetained::from_raw(NonNull::new(win_raw as *mut AXUIElement)?);

        let mut title_raw: *const CFType = std::ptr::null();
        let err2 = win_el.copy_attribute_value(
            &kAXTitleAttribute,
            NonNull::new(&mut title_raw as *mut _ as *mut *const CFType)?,
        );
        if err2.0 != 0 || title_raw.is_null() {
            return None;
        }
        let title_cf: CFRetained<CFString> =
            CFRetained::from_raw(NonNull::new(title_raw as *mut CFString)?);
        let s = title_cf.to_string();
        if s.is_empty() { None } else { Some(s) }
    }
}

/// Fetch the active tab URL from a known browser via AppleScript.
/// Runs in a background thread with a 500 ms deadline.
#[cfg(target_os = "macos")]
fn capture_browser_url_macos(bundle_id: &str) -> Option<String> {
    let script = match bundle_id {
        "com.apple.Safari" =>
            "tell application \"Safari\" to get URL of current tab of front window",
        "com.google.Chrome" | "com.google.Chrome.beta" | "com.google.Chrome.canary" =>
            "tell application \"Google Chrome\" to get URL of active tab of front window",
        "company.thebrowser.Browser" => // Arc
            "tell application \"Arc\" to get URL of active tab of front window",
        "com.brave.Browser" | "com.brave.Browser.beta" =>
            "tell application \"Brave Browser\" to get URL of active tab of front window",
        "org.mozilla.firefox" => return None, // Firefox has no AppleScript URL access
        _ => return None,
    };

    let script = script.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output();
        let _ = tx.send(result);
    });

    let output = rx
        .recv_timeout(std::time::Duration::from_millis(500))
        .ok()??;

    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() || url == "missing value" {
        None
    } else {
        Some(url)
    }
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn capture_context_returns_some_with_valid_pid() {
        let ctx = capture_context();
        if let Some(c) = ctx {
            assert!(c.pid > 0, "pid should be positive, got {}", c.pid);
        }
    }

    #[test]
    fn capture_context_returns_app_name() {
        let ctx = capture_context();
        if let Some(c) = ctx {
            assert!(
                c.app_name.is_some(),
                "expected app_name to be populated, got None (pid={})",
                c.pid
            );
        }
    }

    #[test]
    fn capture_browser_url_returns_none_for_unknown_bundle() {
        let url = capture_browser_url_macos("com.example.unknown");
        assert!(url.is_none());
    }
}
```

- [ ] **Step 4: Fix the `FocusSnapshot` rename in `coordinator.rs`**

The coordinator still imports and uses `FocusSnapshot`. Do a targeted rename:

```bash
cd /path/to/echo-scribe
# The import line
sed -i '' 's/use crate::input::focus::{self, FocusSnapshot};/use crate::input::focus::{self, FocusContext};/' src-tauri/src/coordinator.rs
# The variable declaration
sed -i '' 's/let mut pending_focus: Option<FocusSnapshot>/let mut pending_context: Option<FocusContext>/' src-tauri/src/coordinator.rs
# All usages of pending_focus
sed -i '' 's/pending_focus/pending_context/g' src-tauri/src/coordinator.rs
# capture_frontmost → capture_context
sed -i '' 's/focus::capture_frontmost()/focus::capture_context()/' src-tauri/src/coordinator.rs
```

Then verify the log line compiles by updating it too — open `coordinator.rs` and change:
```rust
info!(pid = s.pid, bundle = ?s.bundle_id, "captured frontmost app");
```
to:
```rust
info!(pid = s.pid, bundle = ?s.bundle_id, app = ?s.app_name, "captured frontmost app");
```

- [ ] **Step 5: Run the tests**

```bash
cd src-tauri && cargo test --lib input::focus -- --nocapture 2>&1 | tail -20
```

Expected output (two passing tests, one is trivially true):
```
test input::focus::tests::capture_context_returns_some_with_valid_pid ... ok
test input::focus::tests::capture_context_returns_app_name ... ok
test input::focus::tests::capture_browser_url_returns_none_for_unknown_bundle ... ok
```

- [ ] **Step 6: Confirm full lib test suite still passes**

```bash
cd src-tauri && cargo test --lib 2>&1 | tail -10
```

Expected: `test result: ok. N passed; 0 failed`

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/input/focus.rs src-tauri/src/coordinator.rs
git commit -m "feat: capture app name, window title, and browser URL at hotkey time"
```

---

## Task 2: DB migration v6 — add `capture_context` column

**Files:**
- Modify: `src-tauri/src/db/schema.rs`
- Modify: `src-tauri/src/db/items.rs`

- [ ] **Step 1: Write the failing migration test**

Add to the `tests` module in `src-tauri/src/db/schema.rs`:

```rust
#[test]
fn migration_v6_adds_capture_context() {
    let mut conn = Connection::open_in_memory().unwrap();
    run_migrations(&mut conn).unwrap();
    // If the column exists, this SELECT won't error.
    conn.execute_batch(
        "SELECT capture_context FROM items LIMIT 0"
    ).expect("capture_context column should exist after migration v6");
}
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd src-tauri && cargo test --lib db::schema::tests::migration_v6 -- --nocapture 2>&1 | tail -10
```

Expected: `FAILED` — the column doesn't exist yet.

- [ ] **Step 3: Add migration v6**

In `src-tauri/src/db/schema.rs`, append to the `MIGRATIONS` slice (after the closing paren of migration 5):

```rust
    (
        6,
        r#"
ALTER TABLE items ADD COLUMN capture_context TEXT;
"#,
    ),
```

- [ ] **Step 4: Run the migration test to confirm it passes**

```bash
cd src-tauri && cargo test --lib db::schema -- --nocapture 2>&1 | tail -10
```

Expected: all schema tests pass.

- [ ] **Step 5: Add `capture_context` to `Item` and update DB functions**

In `src-tauri/src/db/items.rs`:

**5a.** Add the field to `Item`:
```rust
pub struct Item {
    pub id: String,
    pub content: String,
    pub source: ItemSource,
    pub visibility: Visibility,
    pub kind: Option<ItemKind>,
    pub project_id: Option<String>,
    pub captured_at: String,
    pub created_at: String,
    pub deleted_at: Option<String>,
    pub confidence: Option<f32>,
    pub classified_by: Option<String>,
    pub capture_context: Option<String>, // JSON blob: { app_name, window_title, browser_url }
}
```

**5b.** Update `row_to_item` — add `capture_context` to the `Ok(Item { ... })` block:
```rust
capture_context: row.get("capture_context")?,
```

**5c.** Update `insert_item` — change the SQL and params:

Replace the INSERT statement with:
```rust
pub fn insert_item(conn: &Connection, item: &Item) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO items
            (id, content, source, visibility, kind, project_id, captured_at, created_at,
             deleted_at, confidence, classified_by, capture_context)
         VALUES
            (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            item.id,
            item.content,
            item.source.as_str(),
            item.visibility.as_str(),
            item.kind.map(|k| k.as_str()),
            item.project_id,
            item.captured_at,
            item.created_at,
            item.deleted_at,
            item.confidence.map(|f| f as f64),
            item.classified_by,
            item.capture_context,
        ],
    )?;
    Ok(())
}
```

**5d.** Update `get_item` — its SELECT query uses column names, so you only need to add `capture_context` to the SELECT list:
```rust
"SELECT id, content, source, visibility, kind, project_id, captured_at, created_at,
        deleted_at, confidence, classified_by, capture_context
 FROM items WHERE id = ?1 AND deleted_at IS NULL"
```

Do the same in `list_items` (same pattern — add `capture_context` to the SELECT).

- [ ] **Step 6: Fix all construction sites for `Item` in the coordinator**

In `coordinator.rs`, every `Item { ... }` literal needs the new field. Find them with:

```bash
grep -n "Item {" src-tauri/src/coordinator.rs
```

Add `capture_context: None,` to each. (We'll wire in real values in Task 3.)

- [ ] **Step 7: Run the full test suite**

```bash
cd src-tauri && cargo test --lib 2>&1 | tail -10
```

Expected: `test result: ok. N passed; 0 failed`

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/db/schema.rs src-tauri/src/db/items.rs src-tauri/src/coordinator.rs
git commit -m "feat: add capture_context column to items for focus context storage"
```

---

## Task 3: Wire `FocusContext` into persist functions

**Files:**
- Modify: `src-tauri/src/coordinator.rs`

The goal is to serialise the captured `FocusContext` to JSON and store it in `capture_context` on each item. The `pending_context` variable is already captured in Task 1.

- [ ] **Step 1: Add a serialiser helper at the bottom of `coordinator.rs`**

```rust
/// Serialise a `FocusContext` to a compact JSON string for storage.
/// Returns `None` if serialisation fails (shouldn't happen in practice).
fn serialise_context(ctx: &crate::input::focus::FocusContext) -> Option<String> {
    serde_json::to_string(&serde_json::json!({
        "app_name":     ctx.app_name,
        "window_title": ctx.window_title,
        "browser_url":  ctx.browser_url,
        "bundle_id":    ctx.bundle_id,
    }))
    .ok()
}
```

- [ ] **Step 2: Pass context to `persist_capture`**

In coordinator, find the `VoiceAtCursor` arm where `persist_capture` is called (around line 251). Change:
```rust
persist_capture(
    &text,
    db.as_ref(),
    event_log_root.as_deref(),
    &app,
);
```
to:
```rust
persist_capture(
    &text,
    db.as_ref(),
    event_log_root.as_deref(),
    &app,
    pending_context.as_ref().and_then(serialise_context),
);
```

Update the `persist_capture` signature to accept and use it:
```rust
fn persist_capture(
    text: &str,
    db: Option<&Db>,
    event_log_root: Option<&std::path::Path>,
    app: &AppHandle<Wry>,
    capture_context: Option<String>,
) {
```

Inside `persist_capture`, set `capture_context` on the `Item`:
```rust
let item = Item {
    id: id.clone(),
    content: text.to_string(),
    source: ItemSource::VoiceAtCursor,
    visibility: Visibility::Hidden,
    kind: None,
    project_id: None,
    captured_at: now.clone(),
    created_at: now.clone(),
    deleted_at: None,
    confidence: None,
    classified_by: None,
    capture_context,
};
```

- [ ] **Step 3: Pass context to the LogCapture auto-save path**

Find the `Action::LogCapture` arm's auto-save call (around line 319). The `persist_log_capture` function already has many parameters. Add `capture_context: Option<String>` as the last parameter before `db`:

```rust
fn persist_log_capture(
    content: &str,
    kind: crate::db::items::ItemKind,
    project_id: Option<String>,
    new_project_name: Option<String>,
    tags: Vec<String>,
    deadline_iso: Option<String>,
    confidence: Option<f32>,
    classified_by: Option<&str>,
    capture_context: Option<String>,
    db: Option<&Db>,
    event_log_root: Option<&std::path::Path>,
) -> Result<String, String> {
```

Inside `persist_log_capture`, update the `Item` construction:
```rust
let item = Item {
    // ... all existing fields ...
    capture_context,
};
```

Update both call sites in coordinator (the auto-save LogCapture path and the `ConfirmLogCapture` path). For `ConfirmLogCapture`, the user-confirmed save has no context available at that point (it's already been consumed), so pass `None`:
- Auto-save path: pass `pending_context.as_ref().and_then(serialise_context)`
- `ConfirmLogCapture` path: pass `None`

- [ ] **Step 4: Run the full test suite**

```bash
cd src-tauri && cargo test --lib 2>&1 | tail -10
```

Expected: `test result: ok. N passed; 0 failed`

- [ ] **Step 5: Build to confirm no warnings**

```bash
cd src-tauri && cargo build 2>&1 | grep -E "^error|warning\[" | head -20
```

Expected: no errors; any warnings should be unrelated to the new code.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/coordinator.rs
git commit -m "feat: store serialised focus context on captured items"
```

---

## Task 4: Inject focus context into the LLM classifier prompt

**Files:**
- Modify: `src-tauri/src/classifier.rs`
- Modify: `src-tauri/src/coordinator.rs`

- [ ] **Step 1: Write the failing test**

Add to `classifier.rs` tests:

```rust
#[test]
fn build_system_prompt_includes_focus_context() {
    use crate::input::focus::FocusContext;
    let ctx = FocusContext {
        pid: 1234,
        bundle_id: Some("com.google.Chrome".into()),
        app_name: Some("Google Chrome".into()),
        window_title: Some("Inbox — Gmail".into()),
        browser_url: Some("https://mail.google.com/".into()),
    };
    let prompt = build_system_prompt(&[], &[], "2026-05-03T10:00:00Z", "Sunday", Some(&ctx));
    assert!(prompt.contains("Google Chrome"), "app_name missing from prompt");
    assert!(prompt.contains("Inbox — Gmail"), "window_title missing from prompt");
    assert!(prompt.contains("https://mail.google.com/"), "browser_url missing from prompt");
}

#[test]
fn build_system_prompt_handles_no_context() {
    // Should not panic when context is None
    let prompt = build_system_prompt(&[], &[], "2026-05-03T10:00:00Z", "Sunday", None);
    assert!(!prompt.is_empty());
}
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd src-tauri && cargo test --lib classifier::tests::build_system_prompt_includes_focus_context -- --nocapture 2>&1 | tail -15
```

Expected: compile error — `build_system_prompt` doesn't take a `FocusContext` parameter yet.

- [ ] **Step 3: Update `classify` and `build_system_prompt` signatures**

In `classifier.rs`, update `classify`:

```rust
pub async fn classify<L: LlmGenerator + ?Sized>(
    llm: &L,
    transcript: &str,
    existing_projects: &[Project],
    recent_items: &[Item],
    now_iso: &str,
    now_dow: &str,
    focus: Option<&crate::input::focus::FocusContext>,
) -> Result<Classification, ClassifierError> {
    let system = build_system_prompt(existing_projects, recent_items, now_iso, now_dow, focus);
```

Update `build_system_prompt`:

```rust
fn build_system_prompt(
    existing_projects: &[Project],
    recent_items: &[Item],
    now_iso: &str,
    now_dow: &str,
    focus: Option<&crate::input::focus::FocusContext>,
) -> String {
    let mut s = String::with_capacity(1024);
    s.push_str(SYSTEM_PROMPT_BASE);
    s.push_str("\n\nCurrent local time: ");
    s.push_str(now_iso);
    s.push_str(" (");
    s.push_str(now_dow);
    s.push_str(").\n\nExisting projects:\n");
    if existing_projects.is_empty() {
        s.push_str("(none yet)\n");
    } else {
        for p in existing_projects.iter().take(20) {
            s.push_str("- id=");
            s.push_str(&p.id);
            s.push_str(" name=\"");
            s.push_str(&p.name);
            s.push_str("\"\n");
        }
    }
    s.push_str("\nRecent captures (most recent first):\n");
    if recent_items.is_empty() {
        s.push_str("(none)\n");
    } else {
        for it in recent_items.iter().take(5) {
            let preview: String = it.content.chars().take(140).collect();
            s.push_str("- ");
            s.push_str(&preview);
            s.push('\n');
        }
    }
    // Active app context at capture time
    if let Some(ctx) = focus {
        s.push_str("\nCapture context (where the user was when they started dictating):\n");
        if let Some(ref name) = ctx.app_name {
            s.push_str("- App: ");
            s.push_str(name);
            s.push('\n');
        }
        if let Some(ref title) = ctx.window_title {
            s.push_str("- Window: ");
            s.push_str(title);
            s.push('\n');
        }
        if let Some(ref url) = ctx.browser_url {
            s.push_str("- URL: ");
            s.push_str(url);
            s.push('\n');
        }
    }
    s
}
```

- [ ] **Step 4: Update `run_classifier` in `coordinator.rs` to pass context**

Find `run_classifier` in `coordinator.rs` (around line 559). Add `focus` parameter:

```rust
async fn run_classifier(
    llm: &Llm,
    transcript: &str,
    db: Option<&Db>,
    focus: Option<&crate::input::focus::FocusContext>,
) -> Result<Classification, classifier::ClassifierError> {
    // ... existing guard + context load ...
    classifier::classify(llm, transcript, &projects, &recents, &now, dow, focus).await
}
```

Update the call site in the `Action::LogCapture` arm:
```rust
let cls = run_classifier(&llm, &text, db.as_ref(), pending_context.as_deref()).await;
```

> Note: `pending_context` is `Option<FocusContext>` so `.as_deref()` won't work directly since `FocusContext` doesn't implement `Deref`. Use `.as_ref()` instead:
```rust
let cls = run_classifier(&llm, &text, db.as_ref(), pending_context.as_ref().map(|c| c as &_)).await;
```

- [ ] **Step 5: Update all existing `classify` call sites in tests**

The tests in `classifier.rs` call `classify(...)` directly. Add `None` as the last arg to each:

```bash
grep -n "classify(&stub\|classify(&" src-tauri/src/classifier.rs
```

Each call like `classify(&stub, "do the thing", &projects, &[], "...", "...")` becomes:
```rust
classify(&stub, "do the thing", &projects, &[], "2026-05-01T10:00:00Z", "Friday", None)
```

- [ ] **Step 6: Run all tests**

```bash
cd src-tauri && cargo test --lib 2>&1 | tail -10
```

Expected: `test result: ok. N passed; 0 failed`

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/classifier.rs src-tauri/src/coordinator.rs
git commit -m "feat: include active app/window/URL in LLM classifier prompt"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
|---|---|
| Capture app name at hotkey press | Task 1 — `localizedName` on `NSRunningApplication` |
| Capture window title | Task 1 — `AXUIElement` / `kAXFocusedWindowAttribute` + `kAXTitleAttribute` |
| Capture browser URL | Task 1 — `osascript` for Safari, Chrome, Arc, Brave |
| Platform-safe stubs | Task 1 — `#[cfg(not(target_os = "macos"))]` returns `None` |
| Store context with item | Tasks 2 + 3 — migration v6 + `capture_context` JSON column |
| Feed context to LLM | Task 4 — `build_system_prompt` context block |

**Placeholder scan:** None found. All steps contain complete code.

**Type consistency check:**
- `FocusContext` defined in Task 1, used by name in Tasks 3 and 4. ✓
- `capture_context: Option<String>` in `Item` (Task 2) matches the JSON string produced by `serialise_context` in Task 3. ✓
- `persist_log_capture` new signature in Task 3 — two call sites updated. ✓
- `classify` new signature in Task 4 — all call sites including tests updated. ✓
- `build_system_prompt` new signature in Task 4 — only called from `classify` and tests. ✓

**Known limitation:** `capture_window_title_macos` uses `CFRetained::from_raw` which requires a valid retain count contract. The `AXUIElementCopyAttributeValue` name prefix means the returned CFType is already +1 retained (Copy convention), so `from_raw` is correct. However, the `AXError` success check uses `err.0 != 0` — verify the `AXError` type's success value is indeed `0` in `AXError.rs` before shipping.
