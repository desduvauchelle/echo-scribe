# Voice-Edit Selection ("Command Mode") — Design

**Date:** 2026-07-02
**Status:** Approved (design), pending implementation plan
**Author:** Denis + Claude

## Summary

Add a "Command Mode" style feature: the user highlights text in **any** macOS
app, invokes a dedicated global hotkey, **speaks an instruction** ("make this
more concise", "translate to French", "fix the grammar"), and the local Gemma
LLM rewrites the selected text and **replaces it in place**. Fully local — the
highlighted text never leaves the machine.

This closes the single biggest gap versus Wispr Flow (Command Mode) and
superwhisper (selected-text context editing), and it is a natural fit for a
privacy-first local app: arbitrary on-screen text is processed entirely
on-device.

## Goals

- Voice-driven, in-place rewrite of the current text selection in any app.
- Reuse the existing dictation → LLM → paste pipeline; add the minimum new
  surface area.
- Robust selection capture across native, Electron, browser, and terminal apps.
- Never silently corrupt the user's document: a bad/empty/garbage model output
  aborts the edit and leaves the text untouched.
- Follow the project's diagnostics rules: friendly UI message on every failure,
  full technical detail in the daily log.

## Non-Goals (v1 — explicit YAGNI)

- **Preview/confirm mode.** v1 does a **direct replace** (Cmd+Z still undoes).
- **No-selection cursor generation.** If nothing is selected, v1 aborts with a
  hint. The "generate at cursor" case is a possible fast-follow.
- **Preset/template-backed instructions.** v1 is **free-form voice only**; it
  does not (yet) match saved format templates or superwhisper-style "modes".
- **Streaming** the edit into the document.
- **Persisting edits as items.** Edits are actions, not captures.
- **Undo toast / revert affordance.** Rely on native Cmd+Z for v1.
- **Windows.** macOS-only (Accessibility + CGEvent APIs). Non-macOS builds get a
  no-op stub, consistent with the app's other mac-only features.

## Decisions (locked with the user)

1. **Apply behavior:** direct replace over the selection (no preview).
2. **v1 scope:** selection-only (abort when nothing is selected).
3. **Selection capture:** **Approach C — hybrid.** Try the Accessibility API
   (`AXSelectedText`) first; fall back to a synthetic Cmd+C + clipboard read.
4. **Output safety:** a sanitize-and-abort step guards against low-quality local
   model output (2B Gemma) — preamble/quotes/fences are stripped, and
   empty/echoed/refusal output aborts the edit without replacing.
5. **Default hotkey:** `Right Option + E` (builds on the Right-Option modifier
   the voice hotkey already uses; "E" = edit). Rebindable; collision-checked
   against the other three bindings. Final default confirmable in Settings.
6. **Selection cap:** ~1000 words (~4000 chars) to bound latency and context.
7. **Persistence:** log a `selection.edited` event for diagnostics; do **not**
   create a visible item.

## Architecture

The feature slots into the existing coordinator state machine as a **fourth
`Action`**, `EditSelection`, alongside `VoiceAtCursor`, `ActionCommand`, and
`LogCapture`. It reuses the same `Idle → Recording → Processing → Idle` flow,
overlay, tray-state, pause gating, and focus-restore/paste machinery. The only
genuinely new capabilities are (a) reading the current selection and (b) an LLM
"edit" call. Everything else is wiring that mirrors patterns already in the code.

### Data flow

```
Hotkey Pressed (EditSelection)
  → transition Idle → Recording(EditSelection)          [reject if not Idle]
  → capture FocusContext + focused AXUIElement           (existing code)
  → capture_selection(ctx, element):
        AX AXSelectedText  →(empty/unsupported)→  synth Cmd+C + read clipboard
  → selection empty?      → ABORT: soft chime + "Select text first" hint, Idle
                            (no recording started)
  → selection > cap?      → ABORT: "Selection too long to edit (max ~1000 words)"
  → show "Listening for edit instruction…" overlay
  → recorder.start(); asr.warm_up()

Hotkey Released (EditSelection)
  → transition Recording → Processing
  → recorder.stop(); asr.transcribe(samples) → INSTRUCTION text
  → instruction empty?    → ABORT: "Didn't catch an instruction", text untouched
  → prompt = edit_system_prompt + instruction + selected_text
  → llm.edit_selection(...)                              [tray: Thinking]
  → sanitize(output):
        strip preamble / surrounding quotes / code fences
        empty | equals-input-echo | refusal  → ABORT (do NOT replace)
  → apply: AX write-back  element.set(AXSelectedText, result)
           →(non-zero AXError | Copy method)→  restore_focus + Cmd+V paste
  → log `selection.edited` event; play Ready sfx
  → Idle
```

### Selection capture (the hybrid, Approach C)

`capture_selection(ctx, element) -> Option<SelectionSnapshot>`:

1. **AX path:** read `AXSelectedText` (and `AXSelectedTextRange`) from the
   focused element captured at press time. If non-empty, use it. Records
   `method = Ax` and the range for later re-selection.
2. **Cmd+C fallback:** if AX returns empty or is unsupported, synthesize Cmd+C
   (reusing the clipboard save/restore approach in `paste.rs`), then read the
   clipboard. **Heuristic:** if the clipboard is unchanged after Cmd+C, treat it
   as "nothing selected" and abort. Records `method = Copy`, `range = None`.

```rust
struct SelectionSnapshot {
    text: String,
    range: Option<AxRange>,   // char offset+length, AX path only
    method: SelectionMethod,  // Ax | Copy
}
enum SelectionMethod { Ax, Copy }
```

Timing: capture happens **at press** (selection is active and the overlay hasn't
yet stolen focus), mirroring how `pending_context`/`pending_focus_element` are
captured today.

### In-place replacement reliability

The apply step prefers a **direct AX write-back** over synthetic keystrokes:

- **AX method (primary):** call `element.set(AXSelectedText, result)` on the
  captured element. This replaces exactly the selected range with no clipboard
  or keystroke involvement, and does not depend on the app being frontmost or
  the selection surviving focus changes. Works wherever `AXSelectedText` is
  settable (most native/Cocoa text fields).
- **Cmd+V fallback:** when AX write-back returns a non-zero `AXError` (Electron,
  web, terminals) or the selection was captured via Cmd+C, restore focus, wait a
  settle delay, and `paste_at_cursor(result)` — Cmd+V replaces the still-active
  selection. Worst case (selection collapsed during focus restore) the result is
  inserted at the cursor instead of replacing — recoverable via Cmd+Z, and the
  path taken is logged.

## Components (files touched)

| File | Change |
|---|---|
| `src-tauri/src/input/focus.rs` | `SelectionSnapshot`, `SelectionMethod`, `AxRange`; `capture_selection()` (AX read); best-effort `reselect_range()`. |
| `src-tauri/src/input/paste.rs` | `capture_selection_via_copy()` — synth Cmd+C + clipboard read using the existing save/restore pattern; "clipboard unchanged ⇒ nothing selected" heuristic. |
| `src-tauri/src/coordinator.rs` | `Action::EditSelection`; `pending_selection`; press branch (capture + guards); release branch (transcribe → edit → sanitize → reselect → paste); `selection.edited` event. |
| `src-tauri/src/llm/action_launcher.rs` | `edit_selection(llm, instruction, text)` (mirrors `format_text`). |
| `src-tauri/src/llm/prompt.rs` | Strict editor system prompt: "output ONLY the revised text; no preamble, no quotes, no commentary." |
| `src-tauri/src/input/binding.rs`, `input/hotkeys.rs`, `commands.rs`, `settings.rs`, `lib.rs` | Register a 4th binding + listener following the existing 3-binding pattern (`ensure_pipeline_started`). |
| `src/views/Settings.tsx`, `src/components/HotkeyRebinder.tsx`, `src/lib/api.ts` | New "Edit Selection" hotkey row under **Automation**; get/set the binding. |
| `src-tauri/src/overlay/*` | Recording label "Listening for edit instruction…"; processing label "Editing selection…". |

## Output sanitizer

A pure function, independently unit-tested, applied to the LLM output before any
replacement:

- Trim whitespace.
- Strip leading conversational preamble ("Sure, here's…", "Here is the revised
  text:", etc.).
- Strip a single layer of surrounding quotes or Markdown code fences.
- **Abort (return None, do not replace)** if the result is: empty; identical to
  the input (no-op echo); an obvious refusal ("I can't…", "As an AI…"); or a
  verbatim echo of the instruction.

On abort: friendly toast + OS notification when the window is hidden; raw model
output logged at `warn` (it is the user's own text, kept to logs only); the
selection is left untouched.

## Error handling (per project diagnostics rules)

Every failure path: **friendly UI message** (toast event + OS notification when
the main window is hidden, mirroring `notify_format_failure`), **full technical
detail to the daily log**, and **the user's text left untouched**.

| Condition | UI message | Log |
|---|---|---|
| No selection at press | "Select text first" (transient hint), soft chime | `info` |
| Selection too long | "Selection too long to edit (max ~1000 words)" | `warn` |
| Empty instruction transcript | "Didn't catch an instruction" | `info` |
| LLM not ready / no model | "Load a language model in Settings to use Edit Selection" | `warn` |
| LLM output empty/echo/refusal | "Couldn't apply that edit — text left unchanged" | `warn` + raw output |
| Reselect-range unavailable (Copy path) | (none — proceeds, may insert vs replace) | `info` (path taken) |
| Paste failure | existing `asr:error` surface | `error` |

## Concurrency / state

`EditSelection` is exclusive like the other actions (rejected unless `Idle`). No
mid-recording upgrade (unlike LogCapture's promotion from VoiceAtCursor). Honors
the existing tray-pause gating. Tray transitions reuse `Recording → Transcribing
→ Thinking → Idle`.

## Testing

**Unit (pure logic — the testable core):**

- Output sanitizer: preamble/quote/fence stripping; empty/echo/refusal → abort.
  Table-driven.
- Selection-length guard.
- Capture-method decision + Cmd+C fallback trigger, using injected AX/clipboard
  results (keep `capture_selection` thin so the decision logic is testable
  without a live app).
- Coordinator `EditSelection` state transitions (Idle→Recording→Processing→Idle),
  mirroring the existing transition tests.
- Prompt-builder output shape.

**Manual QA matrix (documented, run before merge):**

| App | Expected capture path | Verify |
|---|---|---|
| TextEdit, Mail, Notes | AX | replace-in-place, clipboard restored, Cmd+Z undo |
| Slack, VS Code, Notion (Electron) | Cmd+C fallback | replace or acceptable insert, clipboard restored |
| Chrome (web content) | Cmd+C fallback | replace-in-place |
| Terminal | Cmd+C fallback or graceful abort | no corruption |

## Rollout / build notes

- No new TCC permission category: this reuses **Accessibility** (already granted
  for Cmd+V paste + window-title capture). Per the project's build workflow,
  **no TCC reset** is required for this change.
- macOS-only; non-macOS builds compile the no-op stub path.

## Open items to confirm during implementation

- Final default binding string (`Right Option + E` vs an alternative that avoids
  any collision surfaced by the collision check).
- Exact selection cap (chars vs. tokens) — start at ~4000 chars / ~1000 words.
