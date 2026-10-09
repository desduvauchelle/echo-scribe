import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pet = readFileSync(new URL("../src-tauri/src/desktop_pet.rs", import.meta.url), "utf8");
const settings = readFileSync(new URL("../src-tauri/src/settings.rs", import.meta.url), "utf8");
const tray = readFileSync(new URL("../src-tauri/src/ui/tray.rs", import.meta.url), "utf8");

// Wiring checks: native windows require the macOS application event loop.
test("pet and focus windows follow the user across desktop workspaces", () => {
  for (const label of ["desktop_pet", "desktop_pet_focus"]) {
    const builder = pet.slice(pet.indexOf(`app,\n        "${label}"`) >= 0
      ? pet.indexOf(`app,\n        "${label}"`)
      : pet.indexOf(`app, "${label}"`));
    expect(builder.slice(0, builder.indexOf(".build()"))).toContain(".visible_on_all_workspaces(true)");
  }
});

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

test("dictation status preserves the focus window and avoids its space", () => {
  const overlay = readFileSync(new URL("../src-tauri/src/overlay.rs", import.meta.url), "utf8");
  const showActivity = overlay.slice(overlay.indexOf("fn show_activity_bubble("), overlay.indexOf("fn hide_activity_bubble("));
  expect(showActivity).not.toContain('get_webview_window("desktop_pet_focus")');
  const syncFocus = pet.slice(pet.indexOf("pub fn sync_daily_focus_bubble("), pet.indexOf("pub fn set_focus_visible("));
  expect(syncFocus).not.toContain('"activity_bubble"');
  const column = readFileSync(new URL("../src-tauri/src/notice_column.rs", import.meta.url), "utf8");
  const relayout = column.slice(column.indexOf("pub(crate) fn relayout("), column.indexOf("fn set_tail("));
  // The focus bubble is the first card in the pet's column, so notices stack above it.
  expect(relayout.indexOf('"desktop_pet_focus"')).toBeLessThan(relayout.indexOf("TRANSIENT.contains"));
  expect(showActivity).toContain('relayout(app, Some("activity_bubble"))');
});

test("activity bubble is pet-only and follows visibility changes during capture", () => {
  const overlay = readFileSync(new URL("../src-tauri/src/overlay.rs", import.meta.url), "utf8");
  const show = overlay.slice(overlay.indexOf("fn show_activity_bubble("), overlay.indexOf("fn hide_activity_bubble("));
  expect(show.indexOf("if !pet_visible")).toBeGreaterThanOrEqual(0);
  expect(show.indexOf("if !pet_visible")).toBeLessThan(show.indexOf("create_activity_bubble(app)"));
  expect(show).toContain("remember_activity_bubble(mode, label)");
  const sync = overlay.slice(overlay.indexOf("fn sync_activity_bubble("), overlay.indexOf("pub fn create_activity_bubble("));
  expect(sync).toContain("bubble.hide()");
  expect(sync).toContain("show_activity_bubble(app");
  expect(overlay).toMatch(/fn sync_recording_widget\([^]*?sync_activity_bubble\(app\)/);
  expect(overlay).toMatch(/fn hide_activity_bubble\([^]*?LAST_ACTIVITY_BUBBLE[^]*?\.take\(\)/);
});
