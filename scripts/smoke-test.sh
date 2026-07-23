#!/usr/bin/env bash
# Install + first-launch smoke test.
#
# Runs the REAL install.sh against a locally built release tarball, then
# launches the installed app in smoke mode (ECHO_SCRIBE_SMOKE=1) and waits
# for it to self-report. The app exits 0 once the frontend renders a real
# view and all sidecars are present in the bundle; nonzero (or our backstop
# timeout) means a user's first launch would have been broken.
#
# Usage: scripts/smoke-test.sh EchoScribe-aarch64.tar.gz
#
# Uses a throwaway HOME so the run behaves like a brand-new user's machine
# and never touches the invoking user's settings, models, or logs.
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage: $0 <path-to-EchoScribe-*.tar.gz>" >&2
  exit 2
fi
ARCHIVE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Backstop in case the app hangs before the in-app 90s watchdog even arms
# (e.g. crash loop at exec time keeps a zombie around).
TIMEOUT_SECS=150

WORK_DIR="$(mktemp -d)"
SMOKE_HOME="$WORK_DIR/home"
INSTALL_DIR="$WORK_DIR/Applications"
mkdir -p "$SMOKE_HOME"

APP_BIN="$INSTALL_DIR/Echo Scribe.app/Contents/MacOS/echo-scribe"
LOG_DIR="$SMOKE_HOME/Library/Logs/EchoScribe"

cleanup() {
  if [[ -n "${APP_PID:-}" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -9 "$APP_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "==> Running install.sh against $ARCHIVE"
INSTALL_DIR="$INSTALL_DIR" \
  DOWNLOAD_URL="file://$ARCHIVE" \
  SKIP_STOP=1 \
  SKIP_LAUNCH=1 \
  bash "$ROOT_DIR/install.sh"

if [[ ! -x "$APP_BIN" ]]; then
  echo "SMOKE FAIL: installed bundle has no executable at $APP_BIN" >&2
  exit 1
fi

echo "==> Launching installed app in smoke mode (timeout ${TIMEOUT_SECS}s)"
HOME="$SMOKE_HOME" ECHO_SCRIBE_SMOKE=1 "$APP_BIN" &
APP_PID=$!

STATUS=""
for ((i = 0; i < TIMEOUT_SECS; i++)); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    if wait "$APP_PID"; then STATUS=0; else STATUS=$?; fi
    break
  fi
  sleep 1
done

dump_logs() {
  echo "==> App log (last 200 lines):"
  if compgen -G "$LOG_DIR/echo-scribe.log*" >/dev/null; then
    tail -n 200 "$LOG_DIR"/echo-scribe.log* || true
  else
    echo "(no log file was written under $LOG_DIR)"
  fi
}

if [[ -z "$STATUS" ]]; then
  echo "SMOKE FAIL: app still running after ${TIMEOUT_SECS}s backstop; killing." >&2
  dump_logs
  exit 1
fi

if [[ "$STATUS" -ne 0 ]]; then
  echo "SMOKE FAIL: app exited with status $STATUS" >&2
  dump_logs
  exit 1
fi

echo "Install + first-launch smoke test passed."
