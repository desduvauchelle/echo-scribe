#!/usr/bin/env bash
# Double-click this file after creating the Apple app-specific password.
# Read it privately, validate it with Apple, then save it to Keychain/GitHub.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
umask 077
mkdir -p "$ROOT/output/apple-signing"
STATUS_FILE="$ROOT/output/apple-signing/notarization-setup.status"
STAGE=starting
record_status() { printf '%s\n' "$1" > "$STATUS_FILE"; }
finish() {
  local result=$?
  unset TUCKY_PASSWORD
  if [[ "$STAGE" == complete ]]; then
    record_status complete
  else
    record_status "stopped:$STAGE:exit=$result"
  fi
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
record_status starting
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
for tool in gh xcrun; do
  command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }
done
STAGE=github_login
gh auth status >/dev/null 2>&1 || { echo "GitHub login is required." >&2; exit 1; }
echo "Tucky Apple notarization setup"
echo "Create an app-specific password named 'Tucky GitHub Releases' at account.apple.com."
echo "Enter that password here. It will be hidden and saved only to Keychain and encrypted GitHub Actions secrets."
APPLE_ACCOUNT="${TUCKY_APPLE_ID:-}"
if [[ -z "$APPLE_ACCOUNT" && -f "$ROOT/output/apple-signing/apple-account.txt" ]]; then
  APPLE_ACCOUNT="$(cat "$ROOT/output/apple-signing/apple-account.txt")"
fi
if [[ -z "$APPLE_ACCOUNT" ]]; then
  STAGE=waiting_for_email
  record_status "$STAGE"
  read -r -p "Apple account email: " APPLE_ACCOUNT
fi
if [[ -z "$APPLE_ACCOUNT" ]]; then
  echo "Apple account email is required." >&2
  exit 1
fi
echo "Apple account: $APPLE_ACCOUNT"
STAGE=waiting_for_password
record_status "$STAGE"
read -r -s -p "Paste Apple app-specific password, then press Return: " TUCKY_PASSWORD
echo
if [[ -z "$TUCKY_PASSWORD" ]]; then
  echo "No password entered. Nothing saved." >&2
  exit 1
fi
STAGE=validating_with_apple
record_status "$STAGE"
xcrun notarytool store-credentials tucky-apple-notarization \
  --apple-id "$APPLE_ACCOUNT" --team-id BSH2UEDLU5 \
  --password "$TUCKY_PASSWORD" >/dev/null
STAGE=saving_to_github
record_status "$STAGE"
printf '%s' "$TUCKY_PASSWORD" | gh secret set TUCKY_APPLE_APP_SPECIFIC_PASSWORD \
  --repo desduvauchelle/tucky
unset TUCKY_PASSWORD
STAGE=complete
record_status complete
echo "Apple validated the credential. Saved Keychain profile: tucky-apple-notarization"
echo "Saved encrypted GitHub secret: TUCKY_APPLE_APP_SPECIFIC_PASSWORD"
read -r -p "Press Return to close. " _
