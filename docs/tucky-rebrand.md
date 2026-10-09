# Tucky rebrand

Local source lives in `Documents/code/tucky`; the old `echo-scribe` path remains
an alias so existing project configurations and running tools can resolve it.
The landing page lives in `Documents/code/rs-clients/tucky-landing`, with the
same compatibility alias for `echo-scribe-landing`.

## Local installation and data

Run `bash reinstall.command` to build/sign/install, migrate closed data, refresh
LaunchServices, and open `/Applications/Tucky.app`.

Canonical paths:

- `~/Library/Application Support/Tucky/tucky.db`
- `~/Library/Application Support/Tucky/models` and `llm-models`
- `~/Library/Logs/Tucky/tucky.log.YYYY-MM-DD`
- `~/Tucky/events`
- `~/Library/LaunchAgents/Tucky.plist` when startup was enabled

The migration backs up SQLite to `Tucky/rebrand-backup/echo.db`, verifies its
integrity, checkpoints WAL, and closes connections before renaming the file.
It refuses conflicting directories/databases and an open database. Old
EchoScribe directories become aliases, preserving stored absolute recording
paths. It is safe to rerun after a successful migration. Ordinary upgrades
that have not run this offline migration continue using existing legacy data.

Keep `com.echoscribe.app`: changing the bundle identifier would affect macOS
permissions, keychain services, WebKit settings and identifier-based meeting
storage. Internal crate/helper names, legacy MCP tool aliases, and the old
release archive remain compatibility identifiers. Do not launch an old app
binary against migrated data; the database filename is deliberately not
symlinked because SQLite WAL files depend on the database pathname.

Old notification history and macOS background-item history may still retain
historical labels. The current bundle and login item must identify as Tucky;
verify a newly delivered notification separately from source metadata.

## GitHub and Vercel cutover, completed October 8, 2026

Renamed the existing repositories and updated both local origin URLs:

- https://github.com/desduvauchelle/tucky (repository ID `1188510131`)
- https://github.com/desduvauchelle/tucky-landing (repository ID `1309289621`)

Both old GitHub names resolve to their renamed repositories. Do not recreate
repositories at the old names, which would defeat those redirects.

Published native installer, updater and README repository references in commit
`be02a7ee6a502fefae45c1e0b081ebbe2ea7284c`. This commit deliberately contains
only repository references; unrelated local changes were preserved. The existing
`v1.0.26` release remains available, including both `Tucky-aarch64.tar.gz` and
`EchoScribe-aarch64.tar.gz` for compatibility with installed updaters.

Reconnected the existing Vercel project to `desduvauchelle/tucky-landing`:

- Project ID: `prj_cKhCRCPhZKC3qN4JYv2p12CEWGXH`
- Project name retained: `echo-scribe-landing`
- Production branch: `main`
- Existing domains, build settings, access protection and environment entries
  preserved.
- Added public `NEXT_PUBLIC_TUCKY_GITHUB_REPO=desduvauchelle/tucky` for production
  and preview. Landing links, schema, installer command and download resolver
  share `src/lib/tucky-repository.ts`, whose default is also the new repository.

Landing commit `b45a3c9e3aaabeee8406b190607af9b5df26454a` passed four focused
repository/download tests, TypeScript and commit-time lint checks. Its Git push
triggered a READY preview (`dpl_7bCA9rQ1diVLvRRW5XJ3wLEbZ7BS`). After preview
verification, main triggered a READY production deployment
(`dpl_ELZDwREokFfDGQrwRDE7UHjj8CQJ`), confirmed as the active production target.

Live checks passed:

- https://tucky.ai-juicing.com/ returns 200 with Tucky branding, new GitHub links
  and the renamed installer URL.
- Contact and blog pages return 200; the contact issues link uses the new repo.
- `/download/mac` redirects to the new repository's existing Tucky release asset.
- Both current and legacy release archive URLs return 200.
- https://echo-scribe.ai-juicing.com/ redirects to https://tucky.ai-juicing.com/.
- GitHub main API content, the immutable native commit and the public raw main
  installer URL all contain the new repository reference. Both installer paths
  and release assets remain reachable.

The landing page CMS tenant/storage namespace `echo-scribe-ai-juicing` is a
separate data identity. Leave it intact to preserve editorial content/images.
Renaming it is not part of the GitHub or Vercel project reconnection.

Official references, checked October 8, 2026:

- https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository
- https://vercel.com/docs/cli/git

GitHub documents redirects for renamed repositories and recommends updating
local remotes. Vercel documents Git connect/disconnect for an existing project;
the live deployment checks above verify this project's reconnection.
