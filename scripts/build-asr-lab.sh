#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --release --locked --manifest-path src-tauri/asr-lab/Cargo.toml --target-dir src-tauri/target/asr-lab
bash scripts/setup-qwen-runtime.sh
