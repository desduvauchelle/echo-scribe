#!/usr/bin/env python3
"""Check the latest real capture, read-only, without printing dictated text.

After a dictation in the target app:
  python3 scripts/check-capture-context.py --bundle com.openai.codex
  python3 scripts/check-capture-context.py --bundle com.anthropic.claudefordesktop
Use --after with a UTC ISO timestamp to exclude older captures.
Exit 0 means explicit workspace/project evidence was saved; 1 means missing.
"""
import argparse
import json
import sqlite3
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--after", default="")
    parser.add_argument("--db", type=Path, default=(Path.home() / "Library/Application Support/Tucky/tucky.db" if (Path.home() / "Library/Application Support/Tucky/tucky.db").exists() else Path.home() / "Library/Application Support/EchoScribe/echo.db"))
    args = parser.parse_args()
    with sqlite3.connect(args.db.resolve().as_uri() + "?mode=ro", uri=True) as db:
        rows = db.execute(
            "SELECT id, captured_at, capture_context FROM items "
            "WHERE deleted_at IS NULL AND captured_at > ? "
            "AND capture_context IS NOT NULL ORDER BY captured_at DESC",
            (args.after,),
        )
        for item_id, captured_at, raw in rows:
            try:
                context = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(context, dict) or context.get("bundle_id") != args.bundle:
                continue
            signals = context.get("signals") or []
            project = [s for s in signals if isinstance(s, dict) and s.get("kind") in ("workspace", "project") and s.get("value")]
            print(json.dumps({
                "item_id": item_id,
                "captured_at": captured_at,
                "bundle": args.bundle,
                "content_title": context.get("content_title"),
                "project_evidence": project,
                "diagnostics": context.get("diagnostics"),
                "result": "PASS" if project else "FAIL: no explicit project/workspace captured",
            }, indent=2))
            return 0 if project else 1
    print("No matching capture found.")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
