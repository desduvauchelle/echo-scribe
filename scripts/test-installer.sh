#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

FIXTURE_DIR="$WORK_DIR/fixture"
BIN_DIR="$WORK_DIR/bin"
INSTALL_DIR="$WORK_DIR/Applications"
ARCHIVE="$WORK_DIR/EchoScribe-aarch64.tar.gz"

mkdir -p "$FIXTURE_DIR/Tucky.app/Contents/MacOS" "$BIN_DIR"
printf 'fixture app\n' > "$FIXTURE_DIR/Tucky.app/Contents/Info.plist"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FIXTURE_DIR/Tucky.app/Contents/MacOS/echo-scribe"
chmod +x "$FIXTURE_DIR/Tucky.app/Contents/MacOS/echo-scribe"
tar -czf "$ARCHIVE" -C "$FIXTURE_DIR" "Tucky.app"

cat > "$BIN_DIR/uname" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -s) echo Darwin ;;
  -m) echo arm64 ;;
  *) /usr/bin/uname "$@" ;;
esac
EOF
chmod +x "$BIN_DIR/uname"

for tool in osascript pkill xattr open; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$BIN_DIR/$tool"
  chmod +x "$BIN_DIR/$tool"
done

PATH="$BIN_DIR:$PATH" \
  INSTALL_DIR="$INSTALL_DIR" \
  DOWNLOAD_URL="file://$ARCHIVE" \
  SKIP_STOP=1 \
  SKIP_LAUNCH=1 \
  bash "$ROOT_DIR/install.sh"

test -f "$INSTALL_DIR/Tucky.app/Contents/Info.plist"
test -x "$INSTALL_DIR/Tucky.app/Contents/MacOS/echo-scribe"

echo "Installer integration test passed."

# Upgrade from the old name without stranding MCP executable paths.
rm "$INSTALL_DIR/Echo Scribe.app"
mkdir -p "$INSTALL_DIR/Echo Scribe.app/Contents"
printf 'old installation\n' > "$INSTALL_DIR/Echo Scribe.app/Contents/legacy"
PATH="$BIN_DIR:$PATH" INSTALL_DIR="$INSTALL_DIR" DOWNLOAD_URL="file://$ARCHIVE" \
  SKIP_STOP=1 SKIP_LAUNCH=1 bash "$ROOT_DIR/install.sh"
test -L "$INSTALL_DIR/Echo Scribe.app"
test -x "$INSTALL_DIR/Echo Scribe.app/Contents/MacOS/echo-scribe"
test "$(find "$INSTALL_DIR" -path '*/Echo Scribe.app/Contents/legacy' | wc -l | tr -d ' ')" = 1

# A corrupt download must leave the existing app intact.
mkdir "$WORK_DIR/empty"
tar -czf "$WORK_DIR/invalid.tar.gz" -C "$WORK_DIR/empty" .
if PATH="$BIN_DIR:$PATH" INSTALL_DIR="$INSTALL_DIR" DOWNLOAD_URL="file://$WORK_DIR/invalid.tar.gz" \
  SKIP_STOP=1 SKIP_LAUNCH=1 bash "$ROOT_DIR/install.sh"; then
  echo "Invalid archive unexpectedly installed" >&2; exit 1
fi
test -x "$INSTALL_DIR/Tucky.app/Contents/MacOS/echo-scribe"

# Both release archives must work, including the one the old updater requests.
bash "$ROOT_DIR/scripts/package-release.sh" "$FIXTURE_DIR/Tucky.app" "$WORK_DIR/releases"
tar -tzf "$WORK_DIR/releases/EchoScribe-aarch64.tar.gz" | grep -q '^Echo Scribe.app/Contents/MacOS/echo-scribe$'
PATH="$BIN_DIR:$PATH" INSTALL_DIR="$WORK_DIR/LegacyInstall" \
  DOWNLOAD_URL="file://$WORK_DIR/releases/EchoScribe-aarch64.tar.gz" \
  SKIP_STOP=1 SKIP_LAUNCH=1 bash "$ROOT_DIR/install.sh"
test -x "$WORK_DIR/LegacyInstall/Tucky.app/Contents/MacOS/echo-scribe"
echo "Tucky upgrade, legacy archive, and failed-download preservation checks passed."
