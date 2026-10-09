# Gmail assistant

Tucky connects directly to Gmail's REST API for on-demand search, conversation
context, and reviewed drafts. It does not sync a mailbox or add an inbox view.
Google sign-in follows the desktop OAuth/PKCE and Keychain approach already
used by Tucky's Drive integration and Tamias. Tamias's web client and account
grants are not read or copied.

## Connect

1. In the Google Cloud project used for Tamias (or a separate project), enable
   **Gmail API** and create an OAuth client of type **Desktop app**. Tamias's
   **Web application** client cannot use Tucky's ephemeral loopback callback.
2. Configure Google Auth Platform consent for
   `https://www.googleapis.com/auth/gmail.readonly` and
   `https://www.googleapis.com/auth/gmail.compose`. For an External app in
   Testing, add each connecting Gmail account as a test user.
3. Download the Desktop client JSON and use **Settings → Gmail → Import Google
   OAuth JSON…**. Client configuration and per-account refresh grants are stored
   in macOS Keychain under Tucky's bundle ID. Endpoint overrides in imported
   JSON are ignored. JSON contents and tokens are never returned to the UI.
4. Choose **Connect Gmail account**, select the account in your system browser,
   and grant both email permissions. Tucky validates the returned scopes and
   reads the Gmail profile before recording the connected account.
5. Connect additional accounts the same way. Reconnecting the same account
   preserves its local review drafts. Disconnecting deletes that account's
   local drafts and Keychain grant; it does not delete Gmail drafts or revoke
   the Google app's server-side grant.

Testing grants can expire and require reconnection. Distribution to other users
requires Google consent/verification work for these restricted scopes; this
implementation does not establish approval for public distribution.

Official references:
[desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[threaded replies](https://developers.google.com/workspace/gmail/api/guides/threads).

## Use

Open **Email assistant** from Chat or **Ask Tucky about email** in Gmail Settings.
Gmail-related requests in Chat and triggered voice commands also open the review
window once an account is connected. Existing mailto drafting remains available
when no Gmail account is connected.

- “Tucky, find Alex's latest Gmail email about the website proposal and draft
  a reply saying Tuesday works for me.”
- “Search my emails for the proposal and catch me up on the conversation.”
- “Draft an email to alex@example.com about the meeting.”

The window displays the sending account, recipients, original email, reply
subject, editable body, and actual email sources consulted. The assistant can
search Tucky notes and meetings for additional context when requested.

**Save to Gmail** creates or updates the same Gmail draft. **Send… → Send email**
sends the exact reviewed content. Replies carry the actual parent Message-ID,
References, Gmail thread ID and original subject. The model has no remote save
or send tool. Requests to send instead prepare a local draft for review.

While this window is focused, use the Control dictation shortcut and say
“Tucky, make this shorter” (or “Make this shorter”). The native coordinator
captures current fields and selected text before the recording overlay opens.
Editing uses the draft and its original email as context; ordinary dictation
continues to insert at the captured caret. The selection-edit shortcut also uses
the draft context. A later edit invalidates an older snapshot rather than
silently overwriting it.

Draft edits autosave locally; Gmail saves remain explicit. The sending account
and parent thread cannot be changed by an edit. Reply subjects remain locked to
preserve threading. Larger drafts remain manually editable, but contextual AI
editing is limited to 12,000 body characters. Attachments are not read or sent.

## Boundaries and verification

- Search returns eight messages per page with pagination. Threads return their
  last twelve messages; long bodies and oversized model observations are
  marked partial. HTML bodies are converted to text, without loading remote
  images or rendering email HTML.
- Account IDs scope every search/read/draft. Parent messages must have been
  returned from that account's search or thread read. Email text cannot grant
  new tools. Header injection, malformed addresses, and unsafe reply IDs are
  rejected before a write.
- Local revision checks prevent sending stale drafts. Writes are never retried
  automatically. A persisted sending/saving state or an ambiguous network
  outcome blocks another write; check Gmail Drafts and Sent before preparing a
  new draft. A sent local draft cannot be sent again.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib gmail` covers OAuth
  validation, MIME/Unicode/threading, provider requests against loopback
  fixtures, local revisions, and the model tool allowlist.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib
  gmail::agent::tests::local_model_searches_reads_and_prepares_a_threaded_reply
  -- --ignored --nocapture` exercises the downloaded default local model with
  fixture tools. It never accesses Gmail or modifies user drafts.
- `bun test tests`, `bun run build`, and the existing chat E2E checks cover
  surrounding behavior. For the email review browser check, start
  `bun run preview -- --port 4198 --strictPort` after building, then run
  `bun scripts/check-gmail-review.ts`. The script uses mocked native IPC and
  writes a fixture screenshot to `/tmp/tucky-gmail-review.png`.

Local API fixtures and browser checks do not establish real Google consent,
Keychain access in the installed app, native Control-key delivery, Gmail draft
threading, or delivery. Those require a built/installed app, account consent,
and an explicitly authorized real-mail check.
