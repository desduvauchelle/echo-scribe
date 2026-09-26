#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODEL=sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01
SHA=f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a
CACHE="$ROOT/src-tauri/wakeword/target/model-cache"
DEST="$ROOT/src-tauri/resources/wakeword"
mkdir -p "$CACHE" "$DEST" "$ROOT/src-tauri/binaries"
ARCHIVE="$CACHE/$MODEL.tar.bz2"
if [ ! -f "$ARCHIVE" ]; then
  curl -fL --retry 2 "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/$MODEL.tar.bz2" -o "$ARCHIVE.part"
  mv "$ARCHIVE.part" "$ARCHIVE"
fi
printf '%s  %s\n' "$SHA" "$ARCHIVE" | shasum -a 256 -c -
tar -xjf "$ARCHIVE" -C "$CACHE"
cp "$CACHE/$MODEL/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx" "$DEST/encoder.onnx"
cp "$CACHE/$MODEL/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx" "$DEST/decoder.onnx"
cp "$CACHE/$MODEL/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx" "$DEST/joiner.onnx"
cp "$CACHE/$MODEL/tokens.txt" "$DEST/tokens.txt"
cp "$CACHE/$MODEL/README.md" "$DEST/MODEL-CARD.md"
TRIPLE="${TARGET:-$(rustc -vV | sed -n 's/^host: //p')}"
cargo build --manifest-path "$ROOT/src-tauri/wakeword/Cargo.toml" --release --locked --target "$TRIPLE"
cp "$ROOT/src-tauri/wakeword/target/$TRIPLE/release/tucky-wakeword" "$ROOT/src-tauri/binaries/tucky-wakeword-$TRIPLE"
