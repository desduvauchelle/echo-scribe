#!/usr/bin/env bash
# Import only the release certificate into an ephemeral GitHub-hosted keychain.
set -euo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true ]]; then
  echo "This script is only for GitHub Actions runners." >&2
  exit 1
fi
for name in TUCKY_APPLE_CERTIFICATE_P12_BASE64 TUCKY_APPLE_CERTIFICATE_PASSWORD TUCKY_APPLE_ID TUCKY_APPLE_APP_SPECIFIC_PASSWORD TUCKY_APPLE_TEAM_ID; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing GitHub Actions secret: $name" >&2
    exit 1
  fi
done
: "${RUNNER_TEMP:?}"
: "${GITHUB_ENV:?}"
umask 077
KEYCHAIN="$RUNNER_TEMP/tucky-signing.keychain-db"
CERTIFICATE="$RUNNER_TEMP/tucky-signing.p12"
KEYCHAIN_PASSWORD="$(openssl rand -hex 32)"
echo "::add-mask::$KEYCHAIN_PASSWORD"
trap 'rm -f "$CERTIFICATE"' EXIT
printf '%s' "$TUCKY_APPLE_CERTIFICATE_P12_BASE64" | base64 --decode > "$CERTIFICATE"
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$CERTIFICATE" -k "$KEYCHAIN" -P "$TUCKY_APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
# Preserve the runner's existing keychain search list.
python3 - "$KEYCHAIN" <<'PY'
import shlex, subprocess, sys
existing = shlex.split(subprocess.check_output(['security', 'list-keychains', '-d', 'user'], text=True))
subprocess.run(['security', 'list-keychains', '-d', 'user', '-s', sys.argv[1], *existing], check=True)
PY
xcrun notarytool store-credentials tucky-apple-notarization --keychain "$KEYCHAIN" \
  --apple-id "$TUCKY_APPLE_ID" --password "$TUCKY_APPLE_APP_SPECIFIC_PASSWORD" --team-id "$TUCKY_APPLE_TEAM_ID" >/dev/null
printf 'TUCKY_NOTARY_KEYCHAIN=%s\nTUCKY_NOTARY_PROFILE=tucky-apple-notarization\n' "$KEYCHAIN" >> "$GITHUB_ENV"
