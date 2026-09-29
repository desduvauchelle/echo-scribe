#!/usr/bin/env bash
# usage: frames-at.sh <video> <outprefix> t1 t2 ...  → 3-wide contact sheets of frames at the given seconds
set -euo pipefail
V="$1"; P="$2"; shift 2; D=$(mktemp -d); i=0
for t in "$@"; do i=$((i+1)); ffmpeg -loglevel error -y -ss "$t" -i "$V" -frames:v 1 -vf scale=640:-1 "$D/$(printf %02d $i).png"; done
ffmpeg -loglevel error -y -i "$D/%02d.png" -vf "tile=3x4:padding=6:color=red" -frames:v 1 "${P}A.png"
[ $i -gt 12 ] && ffmpeg -loglevel error -y -start_number 13 -i "$D/%02d.png" -vf "tile=3x4:padding=6:color=red" -frames:v 1 "${P}B.png" || true
rm -rf "$D"
