# Project assistant and reference folders

In Settings → Projects, create or edit a project and choose **Add folder…**.
The native folder chooser supports multiple selections. Folder links, project
purpose, and instructions are saved with the project. **Reconnect…** replaces
a missing folder's location; **Remove** removes only the reference link.
Existing export folders remain separate.

Use **Ask Tucky about projects**, or dictate a command beginning with your
configured Tucky trigger:

- “Tucky, create a project called Website and let me choose its folders.”
- “Tucky, update the Website project's purpose to launch our new site.”
- “Tucky, add a task to the LiveCase project to finish the Zendesk pipeline.”
- “Tucky, add a note to the LiveCase project about the support workflow.”
- “Tucky, update the Zendesk pipeline task in LiveCase.”
- “Tucky, mark the Zendesk pipeline task done in LiveCase.”
- “Tucky, search the Website project files and read the navigation decision.”
- “Tucky, archive the Website project.”

A downloaded, selected local language model is required. The result panel
shows the answer, actual completed changes, and references consulted. File
references reveal the file in Finder; saved-note references open the note.
Each request is independent; include the project name. Stop prevents the next
step, retaining changes already completed. A running generation or native
folder chooser must return before the request finishes stopping.

## Boundaries

- The internal project tool loop supports project create, list, read, update,
  archive, restore, link and unlink; task and note create, list and update; task
  completion and reopening; reference search/read; and project-scoped note search.
  It does not add write tools to the external MCP server.
- Up to 12 folders per project, with read-only access to text, Markdown, CSV,
  configuration, and source files. PDF, Office documents, binary files, hidden
  files, and common generated directories are excluded. Maximum file size is
  256 KB. Files remain in their original folders; no background indexing runs.
- Search is bounded to 2,000 directory entries, 8 MB of reads, and 12 matches
  per call. Read results contain at most 100 lines and 12 KB. Tool results
  report partial searches and excerpts; the model can narrow a search or read
  a subsequent passage.
- The model receives project/folder IDs and relative file paths, never an
  arbitrary-path read or shell tool. Canonical paths must stay inside a linked
  root. Moved roots require reconnection; hidden-file and escaping symlink
  reads are rejected.
- There is at most one project request at a time and ten model steps per
  request. Successful mutations are not repeated. Once reference reading
  begins, mutation tools are disabled for the rest of that request.
- Unknown numeric citations are rejected. If the model omits inline citations,
  Tucky attaches the actual consulted reference list. This verifies source
  provenance, not whether every generated claim follows from the source.

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml --lib project`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib local_model_routes_and_uses_project_tools -- --ignored --nocapture`
  runs the downloaded local model against fixture tool responses without
  changing user projects.
- `bun test tests`, `bun run build`, and `cargo build --manifest-path src-tauri/Cargo.toml --bins`
- Browser QA uses mocked native IPC. Actual Finder selection and spoken commands
  in a packaged/installed app require a separate native smoke check.
