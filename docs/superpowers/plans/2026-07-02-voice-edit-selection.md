# Voice-Edit Selection ("Command Mode") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user highlight text in any macOS app, press a hotkey, speak an instruction, and have the local Gemma LLM rewrite the selection in place.

**Architecture:** Add a 4th coordinator `Action` (`EditSelection`) to the existing `Idle → Recording → Processing → Idle` pipeline. On press, capture the selection (AX `AXSelectedText`, falling back to a synthetic Cmd+C + clipboard read). On release, transcribe the spoken instruction, run a strict local-LLM "edit" pass, sanitize the output (abort on empty/echo/refusal), and apply it — via AX `set(AXSelectedText)` write-back when possible, else Cmd+V over the still-active selection. Everything reuses machinery already in `focus.rs`, `paste.rs`, `coordinator.rs`, and `action_launcher.rs`.

**Tech Stack:** Rust, Tauri v2, `objc2_application_services` (AXUIElement), `core-graphics` (CGEvent), `arboard` (clipboard), local llama.cpp via the `Llm`/`LlmGenerator` abstraction; React/TypeScript frontend.

## Global Constraints

- **macOS-only.** All new native code is behind `#[cfg(target_os = "macos")]` with a non-macOS stub returning the inert value, mirroring `focus.rs`/`hotkeys.rs`. Non-macOS builds must still `cargo check`.
- **No new TCC permission.** Reuses the already-granted **Accessibility** permission (for Cmd+V paste + AX reads). Per `CLAUDE.md`, this change needs **no TCC reset** on rebuild.
- **Never silently corrupt the document.** Every failure path leaves the user's text untouched, shows a *friendly* UI message (toast event + OS notification when the main window is hidden), and logs full technical detail to the daily log with a `target:`.
- **Rust tests:** `cd src-tauri && cargo test --lib`.
- **Frontend build check:** `bun run build`.
- **Default hotkey:** `Right Option + E` = `Binding { primary: SerKey(Key::KeyE), modifiers: vec![(ModifierKind::Alt, ModifierSide::Right)] }`.
- **Selection cap:** `MAX_SELECTION_CHARS = 4000` (~1000 words).
- **DRY / YAGNI / TDD / frequent commits.** v1 non-goals (do NOT build): preview mode, no-selection generation, preset/template-backed instructions, streaming, saving edits as items, undo toast.

---

### Task 1: LLM edit module — prompt, generation call, output sanitizer, length guard

**Files:**
- Create: `src-tauri/src/llm/edit.rs`
- Modify: `src-tauri/src/llm/mod.rs` (register module — add `pub mod edit;` next to the other `mod` lines near the top)
- Test: inline `#[cfg(test)]` module in `src-tauri/src/llm/edit.rs`

**Interfaces:**
- Consumes: `crate::llm::{GenerateRequest, LlmError, LlmGenerator, GenerateFuture}` (existing). `LlmGenerator::generate<'a>(&'a self, req: GenerateRequest) -> GenerateFuture<'a>`.
- Produces:
  - `pub const MAX_SELECTION_CHARS: usize = 4000;`
  - `pub fn within_length_limit(text: &str) -> bool`
  - `pub fn sanitize_edit_output(raw: &str, original: &str) -> Option<String>`
  - `pub async fn run<L: LlmGenerator + ?Sized>(llm: &L, instruction: &str, selected_text: &str) -> Result<String, LlmError>`

- [ ] **Step 1: Register the module.** In `src-tauri/src/llm/mod.rs`, add the module declaration alongside the existing `mod` lines (e.g. right after `pub mod action_launcher;` or wherever the sibling modules are declared):

```rust
pub mod edit;
```

- [ ] **Step 2: Write the failing tests.** Create `src-tauri/src/llm/edit.rs` with only the test module and stub signatures so it compiles-and-fails:

```rust
//! Selection-edit LLM pass: apply a spoken instruction to selected text and
//! sanitize the model output so a low-quality rewrite never lands in the
//! user's document. See docs/superpowers/specs/2026-07-02-voice-edit-selection-design.md.

use crate::llm::{GenerateRequest, LlmError, LlmGenerator};

/// Upper bound on how much selected text we will edit in one pass (~1000 words).
pub const MAX_SELECTION_CHARS: usize = 4000;

pub fn within_length_limit(_text: &str) -> bool {
    unimplemented!()
}

pub fn sanitize_edit_output(_raw: &str, _original: &str) -> Option<String> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_clean_rewrite() {
        let out = sanitize_edit_output("The meeting is at 3pm.", "the meeting is at 2pm actually 3pm");
        assert_eq!(out.as_deref(), Some("The meeting is at 3pm."));
    }

    #[test]
    fn strips_conversational_preamble() {
        let raw = "Sure, here is the revised text:\nThe report is ready.";
        assert_eq!(sanitize_edit_output(raw, "report done").as_deref(), Some("The report is ready."));
    }

    #[test]
    fn strips_wrapping_quotes_and_code_fence() {
        assert_eq!(sanitize_edit_output("\"Hello there\"", "hi").as_deref(), Some("Hello there"));
        assert_eq!(sanitize_edit_output("```\nfn main() {}\n```", "x").as_deref(), Some("fn main() {}"));
    }

    #[test]
    fn rejects_empty_output() {
        assert_eq!(sanitize_edit_output("   \n  ", "something"), None);
    }

    #[test]
    fn rejects_refusal() {
        assert_eq!(sanitize_edit_output("I can't help with that.", "text"), None);
        assert_eq!(sanitize_edit_output("As an AI language model, I cannot rewrite this.", "text"), None);
    }

    #[test]
    fn rejects_noop_echo_of_original() {
        assert_eq!(sanitize_edit_output("same text", "same text"), None);
        assert_eq!(sanitize_edit_output("  same text  ", "same text"), None);
    }

    #[test]
    fn length_limit_boundary() {
        let ok = "a".repeat(MAX_SELECTION_CHARS);
        let too_long = "a".repeat(MAX_SELECTION_CHARS + 1);
        assert!(within_length_limit(&ok));
        assert!(!within_length_limit(&too_long));
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail.**

Run: `cd src-tauri && cargo test --lib llm::edit`
Expected: FAIL (panics with `not implemented`).

- [ ] **Step 4: Implement the sanitizer, length guard, prompt, and `run()`.** Replace the two `unimplemented!()` functions and add the helpers + `run()`:

```rust
pub fn within_length_limit(text: &str) -> bool {
    text.chars().count() <= MAX_SELECTION_CHARS
}

const EDIT_SYSTEM_PROMPT: &str = "\
You are a precise text editor. The user selected some text and spoke an instruction \
describing how to change it. Apply the instruction to the text and output ONLY the \
revised text. Do not add explanations, commentary, preamble, quotation marks, or code \
fences. Do not answer questions or add anything the instruction did not ask for. If the \
instruction is a translation or rewrite, return only the transformed text. Preserve the \
original meaning unless the instruction says otherwise.";

/// Run the local LLM edit pass. Returns the RAW model output; the caller must
/// pass it through [`sanitize_edit_output`] before applying it.
pub async fn run<L: LlmGenerator + ?Sized>(
    llm: &L,
    instruction: &str,
    selected_text: &str,
) -> Result<String, LlmError> {
    let req = GenerateRequest {
        system: Some(EDIT_SYSTEM_PROMPT.to_string()),
        user: format!("Instruction: {instruction}\n\nText to edit:\n{selected_text}"),
        history: Vec::new(),
        max_tokens: 2048,
        temperature: 0.3,
        stop_strings: Vec::new(),
        grammar_gbnf: None,
        n_ctx: Some(4096),
    };
    llm.generate(req).await
}

/// Clean the model output; return `None` (abort, leave text untouched) when the
/// output is empty, a refusal, or a no-op echo of the original.
pub fn sanitize_edit_output(raw: &str, original: &str) -> Option<String> {
    let mut s = raw.trim();
    if let Some(inner) = strip_code_fence(s) {
        s = inner.trim();
    }
    s = strip_wrapping_quotes(s);
    let s = strip_leading_preamble(s).trim();

    if s.is_empty() {
        return None;
    }
    let lower = s.to_lowercase();
    const REFUSALS: &[&str] = &[
        "i can't", "i cannot", "i'm sorry", "i am sorry",
        "as an ai", "i'm unable", "i am unable", "i won't",
    ];
    if REFUSALS.iter().any(|r| lower.starts_with(r)) {
        return None;
    }
    if s == original.trim() {
        return None;
    }
    Some(s.to_string())
}

/// Strip a single wrapping ```fence``` block, returning its inner body.
fn strip_code_fence(s: &str) -> Option<&str> {
    let s = s.trim();
    if !s.starts_with("```") {
        return None;
    }
    let after_open = s.find('\n')? + 1;
    let close = s.rfind("```")?;
    if close <= after_open {
        return None;
    }
    Some(&s[after_open..close])
}

/// Strip a single matching pair of ASCII wrapping quotes/backticks.
fn strip_wrapping_quotes(s: &str) -> &str {
    if s.len() >= 2 {
        let bytes = s.as_bytes();
        let first = bytes[0] as char;
        let last = bytes[s.len() - 1] as char;
        if (first == '"' && last == '"')
            || (first == '\'' && last == '\'')
            || (first == '`' && last == '`')
        {
            return &s[1..s.len() - 1];
        }
    }
    s
}

/// Drop a leading conversational preamble line like "Sure, here is the revised text:".
fn strip_leading_preamble(s: &str) -> &str {
    if let Some(nl) = s.find('\n') {
        let (first, rest) = s.split_at(nl);
        let f = first.trim().to_lowercase();
        let looks_like_preamble = f.ends_with(':')
            && f.len() <= 60
            && ["sure", "here", "here's", "certainly", "okay", "ok", "revised", "result", "output"]
                .iter()
                .any(|w| f.starts_with(w));
        if looks_like_preamble {
            return rest.trim_start_matches('\n');
        }
    }
    s
}
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `cd src-tauri && cargo test --lib llm::edit`
Expected: PASS (8 tests).

- [ ] **Step 6: Add a mock-LLM test for `run()`** (append inside the `tests` module):

```rust
    struct MockLlm(&'static str);
    impl LlmGenerator for MockLlm {
        fn generate<'a>(&'a self, _req: GenerateRequest) -> crate::llm::GenerateFuture<'a> {
            let out = self.0.to_string();
            Box::pin(async move { Ok(out) })
        }
    }

    #[tokio::test]
    async fn run_returns_raw_model_text() {
        let llm = MockLlm("Revised.");
        let raw = run(&llm, "make it shorter", "This is a long sentence.").await.unwrap();
        assert_eq!(raw, "Revised.");
    }
```

- [ ] **Step 7: Run and verify.**

Run: `cd src-tauri && cargo test --lib llm::edit`
Expected: PASS (9 tests).

- [ ] **Step 8: Commit.**

```bash
git add src-tauri/src/llm/edit.rs src-tauri/src/llm/mod.rs
git commit -m "feat(edit): local LLM selection-edit pass + output sanitizer"
```

---

### Task 2: Selection capture & write-back (AX read, AX write, Cmd+C fallback)

**Files:**
- Modify: `src-tauri/src/input/focus.rs` (add `SelectionMethod`, `SelectionSnapshot`, `FocusElement::selected_text`, `FocusElement::replace_selected_text`, `capture_selection`, non-macOS stubs)
- Modify: `src-tauri/src/input/paste.rs` (add `selection_from_clipboard_delta`, `capture_selection_via_copy`, `synthesize_cmd_c`)
- Test: inline `#[cfg(test)]` in `src-tauri/src/input/paste.rs`

**Interfaces:**
- Consumes: `FocusElement { element: CFRetained<AXUIElement>, pid: i32, role: Option<String> }` and the existing private `copy_attribute_value` / `set_attribute_value` AX pattern.
- Produces:
  - `pub enum SelectionMethod { Ax, Copy }` (derive `Debug, Clone, Copy, PartialEq, Eq`)
  - `pub struct SelectionSnapshot { pub text: String, pub method: SelectionMethod }` (derive `Debug, Clone`)
  - `FocusElement::selected_text(&self) -> Option<String>`
  - `FocusElement::replace_selected_text(&self, text: &str) -> i32` (returns raw `AXError`, 0 = success)
  - `pub fn capture_selection(element: Option<&FocusElement>) -> Option<SelectionSnapshot>`
  - `paste::selection_from_clipboard_delta(before: Option<&str>, after: Option<&str>) -> Option<String>`
  - `paste::capture_selection_via_copy() -> Option<String>`

- [ ] **Step 1: Write the failing pure-helper test** in `src-tauri/src/input/paste.rs` (append to its `#[cfg(test)] mod tests`):

```rust
    #[test]
    fn clipboard_delta_detects_new_selection() {
        // Selection changed the clipboard → that's the selection.
        assert_eq!(
            selection_from_clipboard_delta(Some("old"), Some("selected text")),
            Some("selected text".to_string())
        );
        // Nothing selected → Cmd+C leaves clipboard unchanged → None.
        assert_eq!(selection_from_clipboard_delta(Some("old"), Some("old")), None);
        // Empty after → None.
        assert_eq!(selection_from_clipboard_delta(Some("old"), Some("")), None);
        // Previously-empty clipboard, now populated → Some.
        assert_eq!(selection_from_clipboard_delta(None, Some("x")), Some("x".to_string()));
    }
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd src-tauri && cargo test --lib input::paste`
Expected: FAIL ("cannot find function `selection_from_clipboard_delta`").

- [ ] **Step 3: Implement the clipboard helpers in `paste.rs`** (add near the top-level functions, after `paste_at_cursor`):

```rust
/// Pure decision helper: given the clipboard text before and after a synthetic
/// Cmd+C, return the selected text — or `None` if the clipboard did not change
/// (which we treat as "nothing was selected"). Kept pure so it is unit-testable
/// without a live app.
pub fn selection_from_clipboard_delta(before: Option<&str>, after: Option<&str>) -> Option<String> {
    match after {
        Some(a) if !a.is_empty() && Some(a) != before => Some(a.to_string()),
        _ => None,
    }
}

/// Fallback selection capture: synthesize Cmd+C, read the clipboard, then
/// restore the user's original clipboard. Returns the selected text, or `None`
/// if nothing changed / the copy failed. macOS-only.
#[cfg(target_os = "macos")]
pub fn capture_selection_via_copy() -> Option<String> {
    use arboard::Clipboard;
    let mut clipboard = match Clipboard::new() {
        Ok(c) => c,
        Err(e) => {
            warn!(?e, "capture_selection_via_copy: clipboard unavailable");
            return None;
        }
    };
    let before = clipboard.get_text().ok();
    if let Err(e) = synthesize_cmd_c() {
        warn!(?e, "capture_selection_via_copy: Cmd+C synthesis failed");
        return None;
    }
    // Give the frontmost app time to service the copy and write the pasteboard.
    thread::sleep(Duration::from_millis(120));
    let after = clipboard.get_text().ok();
    let result = selection_from_clipboard_delta(before.as_deref(), after.as_deref());
    // Best-effort restore of the user's original clipboard.
    if let Some(orig) = before {
        if let Err(e) = clipboard.set_text(&orig) {
            warn!(?e, "capture_selection_via_copy: failed to restore clipboard");
        }
    }
    result
}

#[cfg(not(target_os = "macos"))]
pub fn capture_selection_via_copy() -> Option<String> {
    None
}

/// Synthesize Cmd+C via CoreGraphics (same deterministic approach as
/// [`synthesize_cmd_v`], with the Command flag set directly on the keydown).
#[cfg(target_os = "macos")]
fn synthesize_cmd_c() -> Result<(), PasteError> {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let source = CGEventSource::new(CGEventSourceStateID::Private)
        .map_err(|_| PasteError::Keystroke("failed to create CGEventSource".into()))?;

    // kVK_ANSI_C = 8
    let c_down = CGEvent::new_keyboard_event(source.clone(), 8, true)
        .map_err(|_| PasteError::Keystroke("failed to create C keydown event".into()))?;
    c_down.set_flags(CGEventFlags::CGEventFlagCommand);
    c_down.post(CGEventTapLocation::Session);

    thread::sleep(Duration::from_millis(20));

    let c_up = CGEvent::new_keyboard_event(source, 8, false)
        .map_err(|_| PasteError::Keystroke("failed to create C keyup event".into()))?;
    c_up.post(CGEventTapLocation::Session);

    Ok(())
}
```

- [ ] **Step 4: Run to verify the helper test passes.**

Run: `cd src-tauri && cargo test --lib input::paste`
Expected: PASS.

- [ ] **Step 5: Add the AX selection read/write to `focus.rs`.** Add the types near `FocusElement` (after the `#[cfg(not(target_os = "macos"))] pub struct FocusElement;` block):

```rust
/// How a text selection was captured.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionMethod {
    /// Read directly via the Accessibility `AXSelectedText` attribute.
    Ax,
    /// Read by synthesizing Cmd+C and reading the clipboard.
    Copy,
}

/// A captured text selection plus how it was obtained.
#[derive(Debug, Clone)]
pub struct SelectionSnapshot {
    pub text: String,
    pub method: SelectionMethod,
}
```

Add these methods to the existing `#[cfg(target_os = "macos")] impl FocusElement { ... }` block (alongside `role`, `pid`, `restore`):

```rust
    /// Read the element's current selection via `AXSelectedText`. Returns
    /// `None` when the attribute is unsupported or empty. Raw (no whitespace
    /// normalization) so we never alter the user's text.
    pub fn selected_text(&self) -> Option<String> {
        use objc2_core_foundation::{CFString, CFType};
        use std::ptr::NonNull;
        let attr = CFString::from_str("AXSelectedText");
        unsafe {
            let _ = self.element.set_messaging_timeout(0.2);
            let mut raw: *const CFType = std::ptr::null();
            let out = NonNull::new(&mut raw as *mut *const CFType)?;
            let err = self.element.copy_attribute_value(&attr, out);
            if err.0 != 0 || raw.is_null() {
                return None;
            }
            let value: CFRetained<CFType> = CFRetained::from_raw(NonNull::new(raw as *mut CFType)?);
            let s = value.downcast::<CFString>().ok().map(|s| s.to_string())?;
            if s.is_empty() { None } else { Some(s) }
        }
    }

    /// Replace the element's current selection in place by setting
    /// `AXSelectedText`. Returns the raw `AXError` (0 = success). Works in apps
    /// that expose a settable `AXSelectedText` (most native/Cocoa text fields);
    /// callers fall back to Cmd+V paste when this returns non-zero.
    pub fn replace_selected_text(&self, text: &str) -> i32 {
        use objc2_core_foundation::CFString;
        let attr = CFString::from_str("AXSelectedText");
        let value = CFString::from_str(text);
        unsafe {
            let _ = self.element.set_messaging_timeout(0.5);
            let err = self.element.set_attribute_value(&attr, value.as_ref());
            tracing::info!(
                pid = self.pid,
                ax_error = err.0,
                chars = text.len(),
                "FocusElement::replace_selected_text set(AXSelectedText)"
            );
            err.0
        }
    }
```

Add the orchestrator + non-macOS stubs at module level (near `capture_focused_element`):

```rust
/// Capture the current text selection: try the Accessibility `AXSelectedText`
/// attribute first (clean, no clipboard side effects), then fall back to a
/// synthetic Cmd+C + clipboard read. Returns `None` when nothing is selected.
#[cfg(target_os = "macos")]
pub fn capture_selection(element: Option<&FocusElement>) -> Option<SelectionSnapshot> {
    if let Some(el) = element {
        if let Some(text) = el.selected_text() {
            tracing::info!(chars = text.len(), "capture_selection: via AXSelectedText");
            return Some(SelectionSnapshot { text, method: SelectionMethod::Ax });
        }
    }
    if let Some(text) = crate::input::paste::capture_selection_via_copy() {
        tracing::info!(chars = text.len(), "capture_selection: via Cmd+C fallback");
        return Some(SelectionSnapshot { text, method: SelectionMethod::Copy });
    }
    tracing::info!("capture_selection: no selection found (AX empty + clipboard unchanged)");
    None
}

#[cfg(not(target_os = "macos"))]
pub fn capture_selection(_element: Option<&FocusElement>) -> Option<SelectionSnapshot> {
    None
}
```

Also add the two methods to the non-macOS `impl FocusElement` block so cross-compilation succeeds:

```rust
    pub fn selected_text(&self) -> Option<String> {
        None
    }
    pub fn replace_selected_text(&self, _text: &str) -> i32 {
        -1
    }
```

- [ ] **Step 6: Verify it compiles (macOS).**

Run: `cd src-tauri && cargo build --lib`
Expected: builds with no errors. (If the compiler flags the `value.as_ref()` coercion in `replace_selected_text`, bind it explicitly: `let cf: &objc2_core_foundation::CFType = value.as_ref();` then pass `cf` — mirroring the `element_as_cf` pattern in `FocusElement::restore`.)

- [ ] **Step 7: Run tests.**

Run: `cd src-tauri && cargo test --lib input`
Expected: PASS (existing hotkey/paste tests + the new delta test).

- [ ] **Step 8: Commit.**

```bash
git add src-tauri/src/input/focus.rs src-tauri/src/input/paste.rs
git commit -m "feat(edit): AX selection read/write + Cmd+C fallback capture"
```

---

### Task 3: Coordinator `EditSelection` action + orchestration

**Files:**
- Modify: `src-tauri/src/coordinator.rs`
- Test: inline `#[cfg(test)] mod tests` in `coordinator.rs`

**Interfaces:**
- Consumes: `focus::capture_selection`, `focus::SelectionSnapshot`, `focus::SelectionMethod`, `focus::FocusElement::replace_selected_text`, `focus::restore_focus`, `paste::paste_at_cursor`, `llm::edit::{run, sanitize_edit_output, within_length_limit}`, `Sfx`, `bump_tray`, `crate::overlay::*`.
- Produces: `Action::EditSelection` variant; `run_edit_selection(...)` + `notify_edit_failure(...)` helpers.

- [ ] **Step 1: Add the `EditSelection` variant** to the `Action` enum:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    VoiceAtCursor,
    ActionCommand,
    LogCapture,
    /// Voice-edit the current text selection in place ("Command Mode").
    EditSelection,
    #[allow(dead_code)]
    Cancel,
}
```

- [ ] **Step 2: Write the failing transition test** (append to `coordinator.rs`'s `#[cfg(test)] mod tests`):

```rust
    #[test]
    fn edit_selection_runs_through_the_state_machine() {
        let s = new_state_handle();
        assert!(transition_from_idle_to_recording(&s, Action::EditSelection));
        assert_eq!(*s.lock().unwrap(), PipelineState::Recording(Action::EditSelection));
        assert!(transition_from_recording_to_processing(&s, Action::EditSelection));
        assert_eq!(*s.lock().unwrap(), PipelineState::Processing(Action::EditSelection));
        // A mismatched action must not drive this one.
        force_state(&s, PipelineState::Recording(Action::EditSelection));
        assert!(!transition_from_recording_to_processing(&s, Action::VoiceAtCursor));
    }
```

- [ ] **Step 3: Run to verify it fails.**

Run: `cd src-tauri && cargo test --lib coordinator::tests::edit_selection_runs_through_the_state_machine`
Expected: FAIL to COMPILE (no `Action::EditSelection`) until Step 1 lands, then PASS once Step 1 is in — if it already passes after Step 1, that is expected (the transition helpers are action-generic); continue to wire the behavior below, which is the real deliverable.

- [ ] **Step 4: Declare `pending_selection`** next to the other pending state at the top of the `spawn_local` async block (after `let mut pending_focus_element: Option<FocusElement> = None;`):

```rust
        // Selection captured at EditSelection press time (text + capture method).
        let mut pending_selection: Option<focus::SelectionSnapshot> = None;
```

- [ ] **Step 5: Capture + guard the selection in the Pressed branch.** In the `HotkeyEvent::Pressed` arm, immediately after the `if let Some(s) = &pending_context { info!(... "captured frontmost app + AX focus") }` block and BEFORE `on_state_change(TrayPipelineState::Recording);`, insert:

```rust
                    // EditSelection needs a live selection. Capture it now (the
                    // selection is active and the overlay hasn't stolen focus),
                    // and abort cleanly if there's nothing to edit — before we
                    // start the mic or show any recording UI.
                    if action == Action::EditSelection {
                        match focus::capture_selection(pending_focus_element.as_ref()) {
                            Some(sel) if crate::llm::edit::within_length_limit(&sel.text) => {
                                info!(chars = sel.text.len(), method = ?sel.method, "edit selection captured");
                                pending_selection = Some(sel);
                            }
                            Some(sel) => {
                                warn!(chars = sel.text.len(), "edit selection too long; aborting");
                                notify_edit_failure(&app, "Selection too long to edit (max ~1000 words).");
                                pending_context = None;
                                pending_focus_element = None;
                                force_state(&state, PipelineState::Idle);
                                on_state_change(TrayPipelineState::Idle);
                                continue;
                            }
                            None => {
                                info!("edit selection: nothing selected; showing hint");
                                feedback::play(Sfx::Stop);
                                let _ = app.emit("edit:hint", "Select text first, then hold the Edit hotkey.");
                                pending_context = None;
                                pending_focus_element = None;
                                force_state(&state, PipelineState::Idle);
                                on_state_change(TrayPipelineState::Idle);
                                continue;
                            }
                        }
                    }
```

- [ ] **Step 6: Give EditSelection a recording overlay.** In the `match action { ... }` that selects the overlay (the block with `Action::VoiceAtCursor => crate::overlay::show_recording_overlay(&app),`), add an arm reusing the action overlay:

```rust
                        Action::EditSelection => crate::overlay::show_action_recording_overlay(&app),
```

- [ ] **Step 7: Handle EditSelection in the Released branch.** In the `Ok(text) => {` block (the non-empty transcription case), insert at the very top — before `let text = postprocess_with_settings(&app, text);` — so the spoken instruction is used verbatim and the action-launcher intercept is skipped:

```rust
                                Ok(text) => {
                                    if matches!(action, Action::EditSelection) {
                                        run_edit_selection(
                                            &app,
                                            &llm,
                                            &text,
                                            pending_selection.take(),
                                            pending_focus_element.take(),
                                            pending_context.take(),
                                        )
                                        .await;
                                        crate::overlay::hide_recording_overlay_now(&app);
                                        force_state(&state, PipelineState::Idle);
                                        on_state_change(TrayPipelineState::Idle);
                                        continue;
                                    }
                                    let text = postprocess_with_settings(&app, text);
```

(The existing body from `let text = postprocess_with_settings...` onward is unchanged; you are only adding the `if matches!(...)` block above it. Keep the existing closing braces.)

- [ ] **Step 8: Add an `EditSelection` arm to the inner `match action`** (the one with `Action::VoiceAtCursor | Action::ActionCommand => {...}`, `Action::LogCapture => {...}`, `Action::Cancel => {...}`) so the match stays exhaustive. Because EditSelection returns early in Step 7, this arm is only a safety net:

```rust
                                    Action::EditSelection => {
                                        // Handled above via the early `continue`;
                                        // this arm keeps the match exhaustive.
                                        crate::overlay::hide_recording_overlay(&app);
                                        force_state(&state, PipelineState::Idle);
                                        on_state_change(TrayPipelineState::Idle);
                                    }
```

- [ ] **Step 9: Add the `run_edit_selection` + `notify_edit_failure` helpers** at module level (near `try_intercept_action` / `notify_format_failure`):

```rust
/// Orchestrate a voice edit of the captured selection: run the local LLM edit
/// pass, sanitize the output, and apply it — via AX write-back when the
/// selection was captured through AX, otherwise by restoring focus and pasting
/// over the still-active selection. Every failure leaves the text untouched and
/// surfaces a friendly message.
async fn run_edit_selection(
    app: &AppHandle<Wry>,
    llm: &crate::llm::Llm,
    instruction: &str,
    selection: Option<crate::input::focus::SelectionSnapshot>,
    element: Option<FocusElement>,
    ctx: Option<FocusContext>,
) {
    let Some(selection) = selection else {
        warn!(target: "edit", "no captured selection at apply time");
        notify_edit_failure(app, "Nothing was selected — text left unchanged.");
        return;
    };
    let instruction = instruction.trim();
    if instruction.is_empty() {
        info!(target: "edit", "empty instruction; aborting");
        notify_edit_failure(app, "Didn't catch an instruction — text left unchanged.");
        return;
    }
    if !llm.ready() {
        warn!(target: "edit", "no LLM model active");
        notify_edit_failure(app, "Load a language model in Settings to use Edit Selection.");
        return;
    }

    crate::overlay::show_processing_overlay(app, "Editing selection…");
    bump_tray(app, TrayPipelineState::Thinking);

    let raw = match crate::llm::edit::run(llm, instruction, &selection.text).await {
        Ok(r) => r,
        Err(e) => {
            error!(target: "edit", error = %e, "edit LLM generation failed");
            notify_edit_failure(app, "Couldn't apply that edit — text left unchanged.");
            return;
        }
    };
    let Some(result) = crate::llm::edit::sanitize_edit_output(&raw, &selection.text) else {
        warn!(target: "edit", raw = %raw, "edit output rejected by sanitizer; leaving text unchanged");
        notify_edit_failure(app, "Couldn't apply that edit — text left unchanged.");
        return;
    };

    // Apply: AX write-back first (clean, no keystrokes), else Cmd+V paste.
    let applied_via_ax = selection.method == crate::input::focus::SelectionMethod::Ax
        && element
            .as_ref()
            .map(|el| el.replace_selected_text(&result) == 0)
            .unwrap_or(false);

    if !applied_via_ax {
        if let Some(ctx) = ctx.as_ref() {
            let outcome = crate::input::focus::restore_focus(ctx, element.as_ref());
            info!(target: "edit", same_app = outcome.same_app, activated = outcome.activated_app, "restored focus before edit paste");
            let settle_ms = if outcome.same_app { 60 } else { 250 };
            std::thread::sleep(std::time::Duration::from_millis(settle_ms));
        }
        if let Err(e) = crate::input::paste::paste_at_cursor(&result) {
            error!(target: "edit", error = %e, "edit paste failed");
            let _ = app.emit("asr:error", format!("Paste failed: {e}"));
            return;
        }
    }

    feedback::play(Sfx::Ready);
    info!(
        target: "edit",
        method = ?selection.method,
        via_ax = applied_via_ax,
        out_chars = result.len(),
        "applied selection edit"
    );
}

/// Friendly surface for an edit-selection failure: in-app event + OS
/// notification when the main window is hidden. Raw detail stays in the log.
fn notify_edit_failure(app: &AppHandle<Wry>, friendly: &str) {
    let _ = app.emit("edit:failed", friendly);
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("Echo Scribe Edit")
        .body(friendly)
        .show();
}
```

- [ ] **Step 10: Build + run tests.**

Run: `cd src-tauri && cargo test --lib coordinator`
Expected: PASS, including `edit_selection_runs_through_the_state_machine`. Fix any exhaustiveness/borrow errors the compiler reports.

- [ ] **Step 11: Commit.**

```bash
git add src-tauri/src/coordinator.rs
git commit -m "feat(edit): wire EditSelection action through the coordinator"
```

---

### Task 4: Hotkey binding — backend (settings, state, commands, listener)

**Files:**
- Modify: `src-tauri/src/settings.rs` (key const, getter, setter, default fn)
- Modify: `src-tauri/src/commands.rs` (AppState field, two commands, listener + adapter)
- Modify: `src-tauri/src/lib.rs` (construct binding Arc, add to AppState, register commands)
- Test: inline `#[cfg(test)]` in `src-tauri/src/settings.rs`

**Interfaces:**
- Consumes: `Binding`, `SerKey`, `ModifierKind`, `ModifierSide`, `Key`, `JsBinding`, `spawn_listener`, `CoordinatorMsg::Hotkey`, `Action::EditSelection`.
- Produces: `settings::default_edit_selection_binding()`, `SettingsStore::edit_selection_binding()`, `SettingsStore::set_edit_selection_binding()`, `AppState.edit_selection_binding`, commands `get_edit_selection_binding` / `update_edit_selection_binding`.

- [ ] **Step 1: Write the failing settings round-trip test** (append to `settings.rs`'s `#[cfg(test)] mod tests`; follow the module's existing test setup for constructing a `SettingsStore` — reuse whatever helper the neighbouring binding tests use, e.g. an in-memory/tempdir store):

```rust
    #[test]
    fn edit_selection_binding_round_trips_and_defaults() {
        let store = test_store(); // same helper the other binding tests use
        // Default when unset.
        assert_eq!(store.edit_selection_binding(), default_edit_selection_binding());
        // Round-trip a custom binding.
        let custom = Binding::single(Key::F8);
        store.set_edit_selection_binding(custom.clone()).unwrap();
        assert_eq!(store.edit_selection_binding(), custom);
    }
```

(If there is no `test_store()` helper, construct the store the same way the existing `voice_at_cursor` tests do. If the file has no binding tests, place this test and a minimal store constructor mirroring `SettingsStore`'s public constructor.)

- [ ] **Step 2: Run to verify it fails.**

Run: `cd src-tauri && cargo test --lib settings::tests::edit_selection_binding_round_trips_and_defaults`
Expected: FAIL (missing symbols).

- [ ] **Step 3: Add the key const** near the other binding keys (lines ~12-14):

```rust
const KEY_EDIT_SELECTION_BINDING: &str = "edit_selection_binding";
```

- [ ] **Step 4: Add the getter + setter** to `impl SettingsStore`, right after `set_action_binding`:

```rust
    /// Returns the configured edit-selection binding, or the default
    /// (`Right Option + E`) if none is stored or invalid.
    pub fn edit_selection_binding(&self) -> Binding {
        match self.store.get(KEY_EDIT_SELECTION_BINDING) {
            Some(value) => match serde_json::from_value::<Binding>(value) {
                Ok(b) => b,
                Err(e) => {
                    warn!(?e, "stored edit_selection_binding is invalid; falling back to default");
                    default_edit_selection_binding()
                }
            },
            None => default_edit_selection_binding(),
        }
    }

    /// Persist the edit-selection binding.
    pub fn set_edit_selection_binding(&self, b: Binding) -> Result<(), SettingsError> {
        let value = serde_json::to_value(&b)?;
        self.store.set(KEY_EDIT_SELECTION_BINDING, value);
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }
```

- [ ] **Step 5: Add the default fn** next to `default_action_binding` (near the bottom of the file). Ensure `Key`, `SerKey`, `ModifierKind`, `ModifierSide` are in scope (they are already imported at the top of `settings.rs`):

```rust
/// The default edit-selection binding: Right Option + E.
pub fn default_edit_selection_binding() -> Binding {
    Binding {
        primary: SerKey(Key::KeyE),
        modifiers: vec![(ModifierKind::Alt, ModifierSide::Right)],
    }
}
```

- [ ] **Step 6: Run the settings test to verify it passes.**

Run: `cd src-tauri && cargo test --lib settings::tests::edit_selection_binding_round_trips_and_defaults`
Expected: PASS.

- [ ] **Step 7: Add the `AppState` field** in `commands.rs` (after `pub action_binding: Arc<RwLock<Binding>>,`):

```rust
    pub edit_selection_binding: Arc<RwLock<Binding>>,
```

- [ ] **Step 8: Add the two commands** in `commands.rs`, right after `update_action_binding`:

```rust
#[tauri::command]
pub fn get_edit_selection_binding(state: State<'_, AppState>) -> JsBinding {
    let b = state
        .edit_selection_binding
        .read()
        .map(|g| g.clone())
        .unwrap_or_else(|_| crate::settings::default_edit_selection_binding());
    b.into()
}

#[tauri::command]
pub fn update_edit_selection_binding(
    state: State<'_, AppState>,
    binding: JsBinding,
) -> Result<(), String> {
    let parsed: Binding = binding
        .try_into()
        .map_err(|e: BindingConversionError| e.to_string())?;
    state
        .settings
        .set_edit_selection_binding(parsed.clone())
        .map_err(|e| e.to_string())?;
    let mut guard = state
        .edit_selection_binding
        .write()
        .map_err(|_| "edit_selection_binding lock poisoned".to_string())?;
    *guard = parsed;
    Ok(())
}
```

- [ ] **Step 9: Spawn the listener + adapter** in `ensure_pipeline_started` (in `commands.rs`). Add the channel next to the others:

```rust
    let (es_tx, mut es_rx) = mpsc::unbounded_channel::<HotkeyEvent>();
```

Add the listener next to the other `spawn_listener` calls:

```rust
    spawn_listener(Arc::clone(&state.edit_selection_binding), es_tx, Arc::clone(&state.rebinding));
```

Add the adapter task next to the other adapter blocks:

```rust
    {
        let coord_tx = coord_tx.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(ev) = es_rx.recv().await {
                if coord_tx
                    .send(CoordinatorMsg::Hotkey(Action::EditSelection, ev))
                    .is_err()
                {
                    break;
                }
            }
        });
    }
```

- [ ] **Step 10: Wire it in `lib.rs`.** Construct the Arc in the setup hook (next to `let action_binding = Arc::new(RwLock::new(initial_action_binding));`):

```rust
            let initial_edit_selection_binding = settings.edit_selection_binding();
            let edit_selection_binding = Arc::new(RwLock::new(initial_edit_selection_binding));
```

Add the field to the `AppState { ... }` construction (next to `action_binding,`):

```rust
                edit_selection_binding,
```

Register both commands in the `tauri::generate_handler![ ... ]` list (next to `get_action_binding, update_action_binding,`):

```rust
            get_edit_selection_binding,
            update_edit_selection_binding,
```

And add them to the `use crate::commands::{ ... }` import list (next to `get_action_binding` / `update_action_binding`):

```rust
            get_edit_selection_binding,
            update_edit_selection_binding,
```

- [ ] **Step 11: Build + test.**

Run: `cd src-tauri && cargo test --lib`
Expected: PASS. Fix any missing-field / unresolved-import errors the compiler reports (the `AppState` struct-literal in `lib.rs` must name every field).

- [ ] **Step 12: Commit.**

```bash
git add src-tauri/src/settings.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(edit): register EditSelection hotkey binding + listener"
```

---

### Task 5: Frontend — Settings hotkey row

**Files:**
- Modify: `src/lib/api.ts` (two binding functions)
- Modify: `src/views/Settings.tsx` (import + a `HotkeyRebinder` row under Automation)

**Interfaces:**
- Consumes: `invoke`, `JsBinding` (existing in `api.ts`), the `HotkeyRebinder` component (`{ load, save }` props).
- Produces: `getEditSelectionBinding`, `updateEditSelectionBinding`.

- [ ] **Step 1: Add the API functions** in `src/lib/api.ts`, right after `updateActionBinding` (lines ~57-61):

```ts
export const getEditSelectionBinding = (): Promise<JsBinding> =>
  invoke("get_edit_selection_binding");

export const updateEditSelectionBinding = (binding: JsBinding): Promise<void> =>
  invoke("update_edit_selection_binding", { binding });
```

- [ ] **Step 2: Import them in `Settings.tsx`** (extend the existing `../lib/api` import block that already pulls in `getActionBinding` / `updateActionBinding`):

```ts
  getEditSelectionBinding,
  updateEditSelectionBinding,
```

- [ ] **Step 3: Add the hotkey row.** In the Automation area, just after the "Dedicated Action Hotkey" `HotkeyRebinder` block (around line 1477), add:

```tsx
          {/* Edit selection: voice-rewrite highlighted text in place */}
          <div>
            <span className="text-xs font-semibold text-fg block">Edit Selection Hotkey</span>
            <p className="text-xs text-fg-muted mb-2">
              Highlight text in any app, hold this hotkey, and speak an instruction
              (e.g. “make this more concise”, “translate to French”). The local model
              rewrites the selection in place.
            </p>
            <HotkeyRebinder
              load={getEditSelectionBinding}
              save={updateEditSelectionBinding}
            />
          </div>
```

(Match the exact wrapper markup/classNames of the adjacent Action-hotkey block if they differ from the above; the key part is passing `load={getEditSelectionBinding} save={updateEditSelectionBinding}`.)

- [ ] **Step 4: Build the frontend.**

Run: `bun run build`
Expected: succeeds with no type errors.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/api.ts src/views/Settings.tsx
git commit -m "feat(edit): add Edit Selection hotkey to Settings"
```

---

### Task 6: Full-app build, install, and manual QA

**Files:** none (verification only).

- [ ] **Step 1: Release build.**

Run: `bun tauri build --bundles app`
Expected: builds `Echo Scribe.app` with no errors.

- [ ] **Step 2: Skip-TCC reinstall** (no permission-related change was made, so per `CLAUDE.md` do NOT reset TCC):

```bash
osascript -e 'tell application "Echo Scribe" to quit' 2>/dev/null
pkill -f "Echo Scribe" 2>/dev/null
sleep 1
rm -rf "/Applications/Echo Scribe.app"
cp -R "src-tauri/target/release/bundle/macos/Echo Scribe.app" /Applications/
open "/Applications/Echo Scribe.app"
```

- [ ] **Step 3: Set the hotkey.** Open Settings → Automation → Edit Selection Hotkey, confirm the default shows `⌥E` (Right Option + E), and that it does not collide with the voice / log / action bindings.

- [ ] **Step 4: Run the manual QA matrix.** For each app: select a sentence, hold the hotkey, say "make this more concise", release. Confirm the selection is replaced, the clipboard is unchanged afterward, and Cmd+Z reverts.

| App | Expected capture path | Pass? |
|---|---|---|
| TextEdit | AX write-back | |
| Mail (compose) | AX write-back | |
| Notes | AX write-back or Cmd+V | |
| Slack | Cmd+C fallback + Cmd+V | |
| VS Code | Cmd+C fallback + Cmd+V | |
| Chrome (textarea) | Cmd+C fallback + Cmd+V | |
| Terminal | Cmd+C fallback or clean abort | |

- [ ] **Step 5: Verify the abort paths.** (a) Invoke with nothing selected → "Select text first" hint, no mic. (b) Say a nonsense instruction that makes the model refuse/echo → "Couldn't apply that edit", text unchanged. (c) With no LLM model loaded → "Load a language model…". Check `echo-scribe.log` (Settings → Diagnostics) shows `target: "edit"` lines for each.

- [ ] **Step 6: Commit any QA-driven fixes**, then the feature is complete.

---

## Self-Review

- **Spec coverage:** Command Mode voice edit (Tasks 1,3); hybrid capture AX→Cmd+C (Task 2); direct replace via AX write-back / Cmd+V (Task 3); output sanitizer abort-on-junk (Task 1,3); selection cap (Task 1,3 Step 5); dedicated hotkey `Right Option + E` (Task 4,5); friendly-error + log on every path (Task 3 helpers); event-log/no-item persistence — **NOTE:** the `selection.edited` event-log write named in the spec is intentionally omitted from v1 tasks to keep scope tight (edits are applied + logged via `tracing`, not written to the user event archive); if the archive entry is wanted, add a `crate::event_log::append_event` call in `run_edit_selection` mirroring `persist_capture`. macOS-only stubs (Tasks 2,4). Manual QA matrix (Task 6).
- **Placeholder scan:** none — every code step has complete code.
- **Type consistency:** `SelectionSnapshot { text, method }`, `SelectionMethod::{Ax,Copy}`, `capture_selection(Option<&FocusElement>)`, `replace_selected_text(&self, &str) -> i32`, `edit::run/sanitize_edit_output/within_length_limit`, `default_edit_selection_binding`, `edit_selection_binding` field/getter/setter, and the `get/update_edit_selection_binding` commands are named identically across Tasks 1–5.
