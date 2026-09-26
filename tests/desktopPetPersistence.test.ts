import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pet = readFileSync(new URL("../src-tauri/src/desktop_pet.rs", import.meta.url), "utf8");
const settings = readFileSync(new URL("../src-tauri/src/settings.rs", import.meta.url), "utf8");
const tray = readFileSync(new URL("../src-tauri/src/ui/tray.rs", import.meta.url), "utf8");

// Wiring checks: native windows require the macOS application event loop.
test("pet visibility has a durable setting with a hidden default", () => {
  expect(settings).toMatch(/pub fn desktop_pet_visible\(&self\)[\s\S]*?get\("desktop_pet_visible"\)[\s\S]*?unwrap_or\(false\)/);
  expect(settings).toMatch(/pub fn set_desktop_pet_visible[\s\S]*?\.store\.save\(\)/);
});

test("both visibility controls persist the resulting state", () => {
  expect(pet).toMatch(/pub fn hide\([\s\S]*?persist_visibility\(app, false\)/);
  expect(pet).toMatch(/pub fn toggle\([\s\S]*?persist_visibility\(app, visible\)/);
});

test("startup restores visibility before rebuilding the tray", () => {
  expect(tray).toMatch(/std::thread::spawn\(move \|\| \{\s*if let Err\(e\) = crate::desktop_pet::restore_visibility\(&refresh_app\)[\s\S]*?tray.rebuild_menu\(\)/);
  expect(pet).toMatch(/pub fn restore_visibility\([\s\S]*?settings.desktop_pet_visible\(\)[\s\S]*?show_locked\(app\)/);
});
