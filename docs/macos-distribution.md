# Apple-verified macOS installation

Tucky's Finder installer is a Developer ID signed and Apple-notarized DMG.
Open the DMG, quit an existing Tucky instance, drag Tucky into Applications,
and launch it there. macOS requests microphone, camera, screen recording,
and Accessibility permissions as the corresponding features need them.
The bundle identifier and application data directory stay unchanged.
A move from the old local signature to Developer ID may require granting
permissions again on the first launch.

## One-time setup on the build Mac

1. In Xcode Settings, open Apple Accounts, select your paid developer team,
   and choose Manage Certificates. Create a **Developer ID Application**
   certificate. Apple Development and Apple Distribution are different
   certificate types and cannot replace it for this distribution path.
2. Create an app-specific password named **Tucky GitHub Releases** at <https://account.apple.com/> yourself.
   Do not paste that password into chat or commit it to the repository.
3. Double-click `scripts/configure-apple-notarization.command` and enter the
   app-specific password at its hidden prompt. It validates the password
   with Apple and stores it in the named Keychain profile and encrypted
   GitHub secret. You can also configure local notarization alone with:

   ```sh
   xcrun notarytool store-credentials tucky-apple-notarization --apple-id YOUR_APPLE_ID --team-id YOUR_TEAM_ID
   ```

   Enter the app-specific password at the prompt. This validates the account
   and saves the credentials in Keychain.

## Build

```sh
bun run release:mac --check
bun run release:mac
```

The release command checks notarization authentication, builds the app,
signs native libraries and sidecars with Hardened Runtime and timestamps,
adds the existing MCP executable alias, submits the app to Apple, staples
the ticket, and verifies Gatekeeper acceptance. It then creates and signs
a DMG with an Applications shortcut, notarizes and staples the DMG, and
verifies it again. It never strips quarantine or installs into Applications.

Outputs are in `output/mac-release/`. The DMG is named with the current
version and build Mac architecture. The existing Tucky and EchoScribe
updater archives contain the same stapled app. This does not change the
updater protocol or publish anything.

If there are multiple Developer ID certificates, set `APPLE_SIGNING_IDENTITY`
to the full certificate name. Set `TUCKY_NOTARY_PROFILE` to use a different
Keychain profile. Local speech models and benchmark UI remain enabled by
default, matching `reinstall.command`; set both `TUCKY_LOCAL_ASR=0` and
`VITE_LOCAL_ASR=0` for the standard catalog.

Local builds use the installed Apple Development certificate instead of the
old unavailable self-signed identity. This is for development only; the
release command requires a Developer ID Application certificate.
`reinstall.command` remains available for local development.

## GitHub release builds

The Release workflow uses the same signing and notarization command. It
imports the Developer ID certificate into a temporary runner keychain,
validates notarization authentication before building, and removes the
temporary credentials even if the build fails. It publishes the verified
DMG alongside both existing updater archives only after the build,
Gatekeeper checks, MCP checks, and first-launch smoke test pass.

The repository needs these Actions secrets:

| Secret | Value |
| --- | --- |
| `TUCKY_APPLE_CERTIFICATE_P12_BASE64` | Base64-encoded PKCS#12 export of the Developer ID Application certificate and its private key |
| `TUCKY_APPLE_CERTIFICATE_PASSWORD` | Password protecting that PKCS#12 export |
| `TUCKY_APPLE_ID` | Apple account email used for notarization |
| `TUCKY_APPLE_APP_SPECIFIC_PASSWORD` | Apple app-specific password, never the main account password |
| `TUCKY_APPLE_TEAM_ID` | Team ID matching the Developer ID certificate |

Do not put these values in chat, source files, or workflow logs. Export only
the Developer ID identity in Keychain Access, not all identities in the
login keychain. GitHub runners cannot use this Mac's local Keychain profile.
No secret is optional: missing credentials stop the workflow rather than
falling back to an unnotarized public release.

The workflow still runs on version tags or an explicit workflow dispatch.
Tags must include the new workflow and release scripts. Selecting an older
tag builds that tag's old workflow. This setup does not push local changes,
create a tag, run CI, or publish an existing local build automatically.

Local verification:

```sh
python3 scripts/test-ci-release.py
python3 scripts/test-macos-signing.py
python3 scripts/test-macos-release.py
bash scripts/test-installer.sh
```

References: [Apple Developer ID](https://developer.apple.com/developer-id/)
and [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/).
For CI keychain handling, see [GitHub's Apple signing guide](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications).

## Resume after Apple's account update

The account setup is currently blocked by Apple's agreement state. App Store
Connect shows **Developer Information Update In Process** and the current
Free Apps Agreement is **Pending (New Legal Entity)**, although the Developer
account records the Program License Agreement as accepted. Apple Developer
Support has been contacted. Repeated password generation does not resolve
this agreement state.

When the current Free Apps Agreement becomes **Active** and Apple confirms
the account update is complete:

1. Double-click `scripts/configure-apple-notarization.command`. Paste the
   Apple-generated app-specific password at the hidden prompt. Use the
   generated value, not its label or the main Apple account password.
   Successful validation saves the local Keychain profile and the fifth
   GitHub secret. Four certificate/account secrets are already configured.
2. Run `bun run release:mac`. This authenticates before building, then
   performs the real Apple submissions and verifies the stapled app and DMG.
3. Open the resulting DMG in Finder and verify its Applications shortcut.
   Test the approved installation and first launch before publishing.
4. Merge the distribution PR after review and resolve any remaining PR
   checks. Create a new version tag that includes these changes to run the
   real GitHub release workflow. Verify the uploaded DMG and updater archives.

The `macOS distribution checks` workflow tests the release failure gates with
fixtures and no Apple credentials. Passing it proves orchestration and
compatibility, not live notarization. The production workflow still requires
Apple acceptance, stapler validation, Gatekeeper acceptance, and first-launch
smoke testing before publishing.
