import { expect, test } from "bun:test";
import { chromium } from "playwright";

// Run against Vite: PET_TEST_URL=http://127.0.0.1:4187 bun test tests/desktopPetOpen.test.ts
const url = process.env.PET_TEST_URL;
test.skipIf(!url)("pet opens Tucky while focus rows complete tasks and expand inline", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const w = window as any;
      w.__calls = [];
      w.__resizeCalls = [];
      w.isTauri = true;
      w.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "desktop_pet" }, currentWebview: { label: "desktop_pet" } },
        transformCallback: () => 1,
        invoke: async (cmd: string, args?: unknown) => {
          w.__calls.push(cmd);
          if (cmd === "desktop_pet_focus_resize") w.__resizeCalls.push(args);
          if (cmd === "bubble_tail") return { side: "bottom", x: 0 };
          if (cmd === "desktop_pet_state") return { pointer: null, listening: false, levels: [] };
          if (cmd === "get_morning_focus_enabled") return true;
          if (cmd === "get_daily_focus_note") return { content: "Ship the release" };
          if (cmd === "list_focus_tasks") return Array.from({ length: 6 }, (_, index) => ({
            item: { id: `task-${index}`, content: index === 0 ? "Call the customer" : `Extra task ${index + 1}`, project_id: null },
            completed_at: null,
          }));
          if (cmd.startsWith("list_")) return [];
          return null;
        },
      };
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    });
    const calls = () => page.evaluate(() => (window as any).__calls as string[]);
    const clear = () => page.evaluate(() => { (window as any).__calls = []; });
    await page.goto(`${url}/src/desktop-pet/index.html`);
    await page.locator("svg").click();
    expect(await calls()).toContain("show_main_window");
    expect(await calls()).not.toContain("plugin:window|start_dragging");
    await clear();
    const box = (await page.locator("svg").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    expect(await calls()).toContain("plugin:window|start_dragging");
    expect(await calls()).not.toContain("show_main_window");
    await clear();
    await page.locator("svg").click({ button: "right" });
    expect(await calls()).toContain("desktop_pet_context_menu");
    expect(await calls()).not.toContain("show_main_window");
    await clear();
    await page.locator("svg").focus();
    await page.keyboard.press("Enter");
    expect(await calls()).toContain("show_main_window");
    await clear();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.locator("svg").dispatchEvent("pointercancel", { pointerId: 1 });
    await page.mouse.up();
    expect(await calls()).not.toContain("show_main_window");
    await page.goto(`${url}/src/desktop-pet/focus.html`);
    expect(await page.getByText("Focus tasks").count()).toBe(0);
    const spacing = await page.evaluate(() => {
      const bubble = document.querySelector(".pet-focus-bubble")!.getBoundingClientRect();
      const content = document.querySelector(".pet-focus-content")!.getBoundingClientRect();
      const heading = document.querySelector(".pet-focus-header span")!.getBoundingClientRect();
      const note = document.querySelector(".pet-focus-note")!.getBoundingClientRect();
      return { rightGap: bubble.right - content.right, textOffset: heading.left - note.left };
    });
    expect(spacing.rightGap).toBeLessThanOrEqual(2);
    expect(Math.abs(spacing.textOffset)).toBeLessThanOrEqual(1);
    expect(await page.getByRole("button", { name: "Complete Extra task 6" }).count()).toBe(0);
    const more = page.getByRole("button", { name: "Show 3 more tasks in No project" });
    expect(await more.getAttribute("aria-expanded")).toBe("false");
    await more.click();
    expect(await page.getByRole("button", { name: "Complete Extra task 6" }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "Show fewer tasks in No project" }).getAttribute("aria-expanded")).toBe("true");
    expect(await page.locator(".pet-focus-tasks").evaluate(element => getComputedStyle(element).borderTopWidth)).toBe("0px");
    await clear();
    await page.getByRole("button", { name: "Complete Extra task 6" }).click();
    expect(await calls()).toContain("complete_task");
    expect(await calls()).not.toContain("show_main_window");
    await page.getByRole("button", { name: "Show fewer tasks in No project" }).click();
    expect(await page.getByRole("button", { name: "Complete Extra task 6" }).count()).toBe(0);
    const resize = page.getByRole("button", { name: "Resize today's focus from top left" });
    const initialSize = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const corner = (await resize.boundingBox())!;
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.x - 30, corner.y - 25, { steps: 4 });
    await page.mouse.up();
    expect(await calls()).toContain("desktop_pet_focus_resize");
    expect(await calls()).toContain("desktop_pet_focus_save_size");
    expect(await calls()).not.toContain("plugin:window|start_resize_dragging");
    const resizeCalls = await page.evaluate(() => (window as any).__resizeCalls as Array<{ width: number; height: number }>);
    expect(resizeCalls.some(({ width, height }) => width > initialSize.width && height > initialSize.height)).toBe(true);
    await clear();
    await page.getByRole("button", { name: "Complete Call the customer" }).click();
    expect(await calls()).toContain("complete_task");
    expect(await calls()).not.toContain("show_main_window");
    await clear();
    await page.getByText("Call the customer").click();
    expect(await calls()).toContain("complete_task");
    expect(await calls()).not.toContain("show_main_window");
    await clear();
    await page.getByText("Ship the release").click();
    expect(await calls()).toContain("show_main_window");
    await clear();
    await page.getByRole("button", { name: "Ship the release" }).focus();
    await page.keyboard.press("Space");
    expect(await calls()).toContain("show_main_window");
    await clear();
    await page.getByRole("button", { name: "Hide today's focus" }).click();
    expect(await calls()).toContain("desktop_pet_focus_set_visible");
    expect(await calls()).not.toContain("show_main_window");
  } finally {
    await browser.close();
  }
}, 30_000);
