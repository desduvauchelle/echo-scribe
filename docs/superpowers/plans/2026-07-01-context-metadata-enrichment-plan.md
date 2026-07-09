# Context metadata enrichment — capture more, categorize better

**Goal (user):** when dictating or capturing notes, record enough about the active app
(Claude Code project, browser site, window/page title) that transcriptions, notes, and
meetings can be routed to the correct project — both at capture time and during the
periodic background categorization.

## Investigation findings

What already exists:

- `FocusContext` (src-tauri/src/input/focus.rs) captures at hotkey/meeting-start time:
  bundle id, app name, AX window title, browser URL + tab title (Safari/Chrome/Arc/Brave
  via AppleScript), and AX content title/URL (`AXDocument`/`AXURL` — this includes the
  Terminal.app cwd and VS Code document paths).
- Dictation and log-capture items persist it in `items.capture_context` (JSON).
- Periodic project tagger (src-tauri/src/project_tagger.rs, 15-min loop): deterministic
  router (aliases + app/url/window hints + keywords + examples) then LLM pass; both are
  handed the parsed capture context. The classifier prompt renders the context block.
- Meeting synthesis prompt gets window title/tab/URL + calendar match + full project list.

Gaps and bugs found:

1. **BUG — stored context never parses back.** `serialise_context` (coordinator.rs) writes
   a hand-rolled JSON subset without `pid`, but `parse_focus_context` deserializes into
   `FocusContext` whose `pid: i32` is required. Every stored context fails to parse, so the
   background tagger has been running with `focus = None` for all items.
2. **No project derivation from terminals/IDEs.** Nothing distills "Claude Code running in
   ~/Documents/code/echo-scribe" (window title / AXDocument path) into a project signal,
   and the router never matches project *names* — only manually configured aliases/hints.
3. **Meetings carry no capture context on their item row**, `MeetingStartContext` drops
   app name + content title/url, and a meeting whose synthesis returns `project_name:null`
   is never enqueued into `project_tag_jobs` — the transcript keywords are never re-examined.

## Plan

### Phase 1 — fix the context round-trip (bug)
- `#[serde(default)]` on `FocusContext::pid`; serialize the whole struct with serde instead
  of the hand-rolled subset.
- Tests: serialise→parse round-trip; legacy pid-less JSON parses.

### Phase 2 — project hints (Claude Code / terminals / IDEs / browsers)
- New pure fn `derive_project_hints(&FocusContext) -> Vec<String>` in focus.rs:
  - file:// or absolute paths in `content_url` → repo/folder segment (segment after
    code-parent dirs like `code`, `repos`, `projects`, `dev`, `github`; else last
    non-generic dir; strips file names with extensions).
  - window-title segments split on `—/–/-/·/|`: path-like segments run path extraction;
    single-token repo-ish segments (e.g. `echo-scribe`) kept; shell noise (`-zsh`,
    `80×24`, app name) dropped.
  - browser URLs: host (minus www), and `owner/repo` repo segment for
    github/gitlab/bitbucket.
- Store as `project_hints: Vec<String>` (serde default) on `FocusContext`, populated at
  capture; derive-at-read fallback for legacy rows.
- Deterministic router: match normalized project *name* (slug variants:
  `echo scribe` / `echo-scribe` / `echoscribe`) against hints → strong score (+12,
  assigns on its own); hints also appended to the context haystack so existing
  alias/app/url/window-hint scoring sees them.
- LLM classifier prompt: render `- Project hint:` lines.

### Phase 3 — meetings
- `MeetingStartContext` gains `focus: Option<FocusContext>`; all construction sites
  (commands.rs manual/guided/consent, tray.rs, detector.rs auto-start) pass the full
  capture; `MeetingManager::start()` persists it into the meeting item's
  `capture_context`.
- Synthesis context block also renders app name + content title/URL + project hints.
- After finalize (`stop()` and `retry_summary()`), enqueue the meeting item into
  `project_tag_jobs` when `project_id` is NULL so the periodic pass retries with
  transcript keywords + context.
- Tagger LLM pass truncates item content (~1500 chars) so meeting transcripts fit the
  classifier's 4096 n_ctx.

### Phase 4 — verification
- Unit tests per phase (focus derivation, router name/hint routing, round-trip,
  meeting enqueue, prompt rendering). `cd src-tauri && cargo test --lib` green.
