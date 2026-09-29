#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Experimental development runtime; no changes to the system Python or release.
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  exit 0
fi
command -v uv >/dev/null || { echo 'Qwen development setup needs uv (https://docs.astral.sh/uv/).'; exit 1; }
runtime=src-tauri/target/qwen-runtime
if [[ ! -x "$runtime/bin/python" ]]; then
  uv venv --python 3.12 "$runtime"
fi
uv pip install --python "$runtime/bin/python" -r src-tauri/qwen-worker/requirements.txt
