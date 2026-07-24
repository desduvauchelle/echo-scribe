#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

FIXTURE_DIR="$WORK_DIR/fixture"
BIN_DIR="$WORK_DIR/bin"
INSTALL_DIR="$WORK_DIR/Applications"
ARCHIVE="$WORK_DIR/EchoScribe-aarch64.tar.gz"

mkdir -p "$FIXTURE_DIR/Echo Scribe.app/Contents/MacOS" "$BIN_DIR"
printf 'fixture app\n' > "$FIXTURE_DIR/Echo Scribe.app/Contents/Info.plist"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FIXTURE_DIR/Echo Scribe.app/Contents/MacOS/echo-scribe"
chmod +x "$FIXTURE_DIR/Echo Scribe.app/Contents/MacOS/echo-scribe"
tar -czf "$ARCHIVE" -C "$FIXTURE_DIR" "Echo Scribe.app"

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

test -f "$INSTALL_DIR/Echo Scribe.app/Contents/Info.plist"
test -x "$INSTALL_DIR/Echo Scribe.app/Contents/MacOS/echo-scribe"

echo "Installer integration test passed."
