import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("microphone level callback never waits for a window visibility response", () => {
  const source = readFileSync(new URL("../src-tauri/src/overlay.rs", import.meta.url), "utf8");
  const callback = source.split("pub fn emit_levels(")[1].split("\nconst HUD_MIN_WIDTH")[0];
  // CoreAudio invokes this on its IO thread. A synchronous window getter
  // can deadlock with WebKit enumerating audio devices on the main thread.
  expect(callback).not.toMatch(/\.is_visible\s*\(/);
  expect(callback).toContain('bubble.emit("mic-level", levels)');
  expect(callback).toContain('overlay.emit("mic-level", levels)');
  expect(callback).toContain("crate::desktop_pet::update_levels(levels)");
});
