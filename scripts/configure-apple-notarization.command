#!/usr/bin/env bash
# Double-click this file after creating the Apple app-specific password.
# Read it privately, validate it with Apple, then save it to Keychain/GitHub.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
for tool in gh xcrun; do
  command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }
done
gh auth status >/dev/null 2>&1 || { echo "GitHub login is required." >&2; exit 1; }
echo "Tucky Apple notarization setup"
echo "Create an app-specific password named 'Tucky GitHub Releases' at account.apple.com."
echo "Enter that password here. It will be hidden and saved only to Keychain and encrypted GitHub Actions secrets."
APPLE_ACCOUNT="${TUCKY_APPLE_ID:-}"
if [[ -z "$APPLE_ACCOUNT" ]]; then
  read -r -p "Apple account email: " APPLE_ACCOUNT
fi
if [[ -z "$APPLE_ACCOUNT" ]]; then
  echo "Apple account email is required." >&2
  exit 1
fi
read -r -s -p "Apple app-specific password: " TUCKY_PASSWORD
echo
trap 'unset TUCKY_PASSWORD' EXIT
if [[ -z "$TUCKY_PASSWORD" ]]; then
  echo "No password entered. Nothing saved." >&2
  exit 1
fi
xcrun notarytool store-credentials tucky-apple-notarization \
  --apple-id "$APPLE_ACCOUNT" --team-id BSH2UEDLU5 \
  --password "$TUCKY_PASSWORD" >/dev/null
printf '%s' "$TUCKY_PASSWORD" | gh secret set TUCKY_APPLE_APP_SPECIFIC_PASSWORD \
  --repo desduvauchelle/echo-scribe
unset TUCKY_PASSWORD
echo "Apple validated the credential. Saved Keychain profile: tucky-apple-notarization"
echo "Saved encrypted GitHub secret: TUCKY_APPLE_APP_SPECIFIC_PASSWORD"
read -r -p "Press Return to close. " _
