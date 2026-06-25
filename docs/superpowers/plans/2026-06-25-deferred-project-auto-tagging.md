# Deferred Project Auto-Tagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build deferred project auto-tagging for direct voice captures without loading the local LLM after every dictation.

**Architecture:** Add a `project_tagger` Rust subsystem with persistent jobs, routing profiles on projects, deterministic assignment, and a conservative batch worker. The coordinator only enqueues direct voice items; background commands and startup worker process jobs later.

**Tech Stack:** Tauri v2, Rust, rusqlite, React, TypeScript, Tailwind CSS.

---

### Task 1: Fix Baseline Action Launcher Tests

**Files:**
- Modify: `src-tauri/tests/action_launcher_tests.rs`

- [ ] Update each `detect_action(&mock, "...")` call to pass `&[]` as the third `format_templates` argument.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml --test action_launcher_tests`.

### Task 2: Add Queue Schema And DB API

**Files:**
- Modify: `src-tauri/src/db/schema.rs`
- Create: `src-tauri/src/db/project_tag_jobs.rs`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] Add migration 19 for `project_tag_jobs`.
- [ ] Implement idempotent enqueue, pending list, status counts, mark done, defer, and backfill enqueue.
- [ ] Add unit tests for idempotent enqueue and backfill selection.
- [ ] Run `cargo test --lib db::project_tag_jobs`.

### Task 3: Add Project Routing Profile Fields

**Files:**
- Modify: `src-tauri/src/db/schema.rs`
- Modify: `src-tauri/src/db/projects.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/lib/api.ts`
- Modify: `src/components/ProjectEditor.tsx`

- [ ] Add migration 20 for `routing_aliases`, `routing_app_hints`, `routing_url_hints`, `routing_window_hints`, `routing_positive_examples`, and `routing_negative_examples`.
- [ ] Round-trip these arrays through `Project`, `ProjectPatch`, create/update commands, and TypeScript API types.
- [ ] Add project editor controls for aliases, app hints, URL hints, window hints, positive examples, and negative examples.
- [ ] Run project DB tests and `npm run build` or `npm run typecheck` if available.

### Task 4: Add Deterministic Router

**Files:**
- Create: `src-tauri/src/project_tagger.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] Implement scoring over transcript and capture context.
- [ ] Assign on clear winner; defer on no match or ambiguous match.
- [ ] Add tests for alias, context hint, negative examples, and ambiguity.
- [ ] Run `cargo test --lib project_tagger`.

### Task 5: Wire Direct Voice Enqueue And Backfill Commands

**Files:**
- Modify: `src-tauri/src/coordinator.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/api.ts`

- [ ] Enqueue each persisted `VoiceAtCursor` item.
- [ ] Add `project_tagger_backfill`, `project_tagger_status`, and `run_project_tagger_once` commands.
- [ ] Add API wrappers.
- [ ] Add focused tests where possible.

### Task 6: Add Batch Worker And Settings

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/project_tagger.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/views/Settings.tsx`

- [ ] Add project auto-tagging settings with conservative defaults.
- [ ] Spawn a worker that checks every 15 minutes, runs at most hourly when loading LLM, and opportunistically runs up to 5 jobs when the LLM is already loaded.
- [ ] Respect app-local safety gates.
- [ ] Show a compact Settings status row with enable toggle, pending count, and manual backfill/run actions.

### Task 7: Verification

**Files:**
- All touched files

- [ ] Run targeted Rust tests.
- [ ] Run full Rust test suite or document pre-existing failures.
- [ ] Run TypeScript build/typecheck.
- [ ] Inspect `git diff` for unrelated churn.
