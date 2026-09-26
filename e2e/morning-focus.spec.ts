import { expect, test } from "@playwright/test";
import { installTauriMock } from "./mock";

test("morning focus appears at 9, saves and edits without an empty focus board", async ({ page }) => {
  if (process.env.FOCUS_SHOTS) await page.emulateMedia({ colorScheme: process.env.FOCUS_THEME === "light" ? "light" : "dark" });
  await page.clock.install({ time: new Date("2026-09-25T08:59:00") });
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    llmReady: true,
  });
  await page.goto("/");
  await expect(page.locator(".echo-focus-board")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /What are the few things/ })).toHaveCount(0);
  await page.clock.fastForward("01:00");
  await expect(page.getByRole("heading", { name: /What are the few things/ })).toBeVisible();
  if (process.env.FOCUS_SHOTS) await page.screenshot({ path: `${process.env.FOCUS_SHOTS}/morning-prompt.png` });
  await page.setViewportSize({ width: 500, height: 800 });
  const narrowMic = (await page.getByRole("button", { name: "Hold to speak" }).boundingBox())!;
  const narrowSave = (await page.getByRole("button", { name: "Save today's focus" }).boundingBox())!;
  expect(narrowMic.y + narrowMic.height <= narrowSave.y || narrowMic.x + narrowMic.width <= narrowSave.x).toBe(true);
  if (process.env.FOCUS_SHOTS) await page.screenshot({ path: `${process.env.FOCUS_SHOTS}/morning-prompt-narrow.png` });
  await page.setViewportSize({ width: 1280, height: 720 });
  const editor = page.locator(".morning-focus-panel textarea");
  await editor.fill("Finish the release.\nTalk to the customer.\nTake a walk.");
  await page.getByRole("button", { name: "Save today's focus" }).click();
  await expect(page.locator(".tucky-focus-bubble")).toContainText("Finish the release.");
  if (process.env.FOCUS_SHOTS) await page.screenshot({ path: `${process.env.FOCUS_SHOTS}/morning-saved.png` });
  await page.setViewportSize({ width: 500, height: 800 });
  if (process.env.FOCUS_SHOTS) await page.screenshot({ path: `${process.env.FOCUS_SHOTS}/morning-saved-narrow.png` });
  await expect(page.locator(".morning-focus-panel")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".tucky-focus-bubble")).toContainText("Talk to the customer.");
  await page.getByRole("button", { name: "Edit today's focus" }).click();
  await expect(editor).toHaveValue("Finish the release.\nTalk to the customer.\nTake a walk.");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".morning-focus-panel")).toHaveCount(0);
});

test("clearing today's focus removes the saved note", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-25T10:00:00") });
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    llmReady: true,
    dailyFocusNotes: { "2026-09-25": "Ship the release." },
  });
  await page.goto("/");
  await expect(page.locator(".tucky-focus-bubble")).toContainText("Ship the release.");
  await page.getByRole("button", { name: "Edit today's focus" }).click();
  await page.locator(".morning-focus-panel textarea").fill("   ");
  const save = page.getByRole("button", { name: "Save today's focus" });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator(".tucky-focus-bubble")).toHaveCount(0);
  await expect(page.locator(".morning-focus-panel textarea")).toHaveValue("");
  await page.reload();
  await expect(page.locator(".tucky-focus-bubble")).toHaveCount(0);
  await expect(page.locator(".morning-focus-panel textarea")).toHaveValue("");
});

test("morning focus starts compact, grows with text, and can be disabled then restored", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-25T10:00:00") });
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    llmReady: true,
  });
  await page.goto("/");
  const editor = page.locator(".morning-focus-panel textarea");
  await expect(editor).toBeVisible();
  const initialHeight = (await editor.boundingBox())!.height;
  expect(initialHeight).toBeLessThan(70);
  const micBounds = (await page.getByRole("button", { name: "Hold to speak" }).boundingBox())!;
  expect(Math.abs((await editor.boundingBox())!.y - micBounds.y)).toBeLessThan(18);
  await editor.fill("First priority\nSecond priority\nThird priority");
  expect((await editor.boundingBox())!.height).toBeGreaterThan(initialHeight);
  await page.getByRole("button", { name: "Turn off morning focus" }).click();
  await expect(page.locator(".morning-focus-panel")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".morning-focus-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".echo-settings-nav").getByRole("button", { name: "General" }).click();
  const toggle = page.getByRole("checkbox", { name: "Show morning focus" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".morning-focus-panel")).toBeVisible();
});

test("turning off morning focus hides but preserves a saved note", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-25T10:00:00") });
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    llmReady: true,
    dailyFocusNotes: { "2026-09-25": "Ship the release." },
  });
  await page.goto("/");
  await expect(page.locator(".tucky-focus-bubble")).toContainText("Ship the release.");
  await page.getByRole("button", { name: "Edit today's focus" }).click();
  await page.getByRole("button", { name: "Turn off morning focus" }).click();
  await expect(page.locator(".tucky-focus-bubble")).toHaveCount(0);
  await expect(page.locator(".morning-focus-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".echo-settings-nav").getByRole("button", { name: "General" }).click();
  await page.getByRole("checkbox", { name: "Show morning focus" }).check();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".tucky-focus-bubble")).toContainText("Ship the release.");
});

test("holding the voice button records, release transcribes, and the transcript saves", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-25T09:01:00") });
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    llmReady: true,
  });
  await page.goto("/");
  const button = page.getByRole("button", { name: "Hold to speak" });
  const bounds = (await button.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.mouse.up();
  await expect(page.locator(".morning-focus-status")).toHaveText("Transcribing…");
  await page.evaluate(() => {
    const field = document.querySelector<HTMLTextAreaElement>(".morning-focus-panel textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Ship the release and call the customer.");
    field.dispatchEvent(new InputEvent("input", { bubbles: true }));
    field.dispatchEvent(new CustomEvent("echo:dictation-inserted", { bubbles: true }));
  });
  await expect(page.locator(".tucky-focus-bubble")).toContainText("Ship the release and call the customer.");
  const commands = await page.evaluate(() => (window as any).__MOCK_CALLS__.filter((call: any) => call.cmd === "set_daily_focus_recording"));
  expect(commands.map((call: any) => call.args.recording)).toEqual([true, false]);
});

test("a quick release waits for recording to start before stopping", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-25T09:01:00") });
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    llmReady: true,
    deferDailyFocusStart: true,
  });
  await page.goto("/");
  const button = page.getByRole("button", { name: "Hold to speak" });
  const bounds = (await button.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  const commands = () => page.evaluate(() => (window as any).__MOCK_CALLS__.filter((call: any) => call.cmd === "set_daily_focus_recording"));
  expect((await commands()).map((call: any) => call.args.recording)).toEqual([true]);
  await page.evaluate(() => (window as any).__MOCK_DAILY_FOCUS_STARTED__());
  await expect.poll(async () => (await commands()).map((call: any) => call.args.recording)).toEqual([true, false]);
});

test("keyboard press and release control the hold button", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-25T09:01:00") });
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    llmReady: true,
  });
  await page.goto("/");
  const button = page.getByRole("button", { name: "Hold to speak" });
  await button.focus();
  await page.keyboard.down("Space");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.up("Space");
  const commands = await page.evaluate(() => (window as any).__MOCK_CALLS__.filter((call: any) => call.cmd === "set_daily_focus_recording"));
  expect(commands.map((call: any) => call.args.recording)).toEqual([true, false]);
});

test("desktop pet shows today's note in a separate compact speech bubble", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-25T10:00:00") });
  await page.setViewportSize({ width: 300, height: 160 });
  await installTauriMock(page, { dailyFocusNotes: { "2026-09-25": "Ship the release.\nTalk to the customer." } });
  await page.goto("/src/desktop-pet/focus.html");
  await expect(page.getByRole("complementary", { name: "Today's focus" })).toContainText("Talk to the customer.");
  await page.getByRole("button", { name: "Hide today's focus" }).click();
  const focusCommands = await page.evaluate(() => (window as any).__MOCK_CALLS__.filter((call: any) => call.cmd === "desktop_pet_focus_set_visible"));
  expect(focusCommands.map((call: any) => call.args.visible)).toEqual([false]);
  if (process.env.FOCUS_SHOTS) await page.screenshot({ path: `${process.env.FOCUS_SHOTS}/pet-focus-bubble.png` });
});

test("desktop pet focus bubble shows tasks without a note", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-25T10:00:00") });
  await page.setViewportSize({ width: 320, height: 220 });
  await installTauriMock(page, {
    feedItems: [{ id: "focus-1", kind: "task", project_id: null, content: "Call the customer" }],
    focusTaskIds: ["focus-1"],
  });
  await page.goto("/src/desktop-pet/focus.html");
  await expect(page.getByRole("complementary", { name: "Today's focus" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Focus tasks" }).getByRole("listitem")).toHaveText("Call the customer");
  if (process.env.FOCUS_SHOTS) await page.screenshot({ path: `${process.env.FOCUS_SHOTS}/pet-focus-tasks.png` });
});

test("desktop pet focus bubble keeps note and tasks readable together", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-25T10:00:00") });
  await page.setViewportSize({ width: 320, height: 220 });
  const tasks = Array.from({ length: 6 }, (_, index) => ({
    id: `focus-${index}`, kind: "task", project_id: null, content: `Priority ${index + 1}`,
  }));
  await installTauriMock(page, {
    dailyFocusNotes: { "2026-09-25": "Ship the release." },
    feedItems: tasks,
    focusTaskIds: tasks.map((task) => task.id),
  });
  await page.goto("/src/desktop-pet/focus.html");
  const bubble = page.getByRole("complementary", { name: "Today's focus" });
  await expect(bubble).toContainText("Ship the release.");
  await expect(bubble.getByRole("listitem")).toHaveCount(6);
  expect(await page.locator(".pet-focus-content").evaluate((content) => content.scrollHeight > content.clientHeight)).toBe(true);
  if (process.env.FOCUS_SHOTS) await page.screenshot({ path: `${process.env.FOCUS_SHOTS}/pet-focus-combined.png` });
});

test("turning off morning focus removes its pet note but keeps focus tasks", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-25T10:00:00") });
  await installTauriMock(page, {
    dailyFocusNotes: { "2026-09-25": "Ship the release." },
    feedItems: [{ id: "focus-1", kind: "task", project_id: null, content: "Call the customer" }],
    focusTaskIds: ["focus-1"],
  });
  await page.goto("/src/desktop-pet/focus.html");
  const bubble = page.getByRole("complementary", { name: "Today's focus" });
  await expect(bubble).toContainText("Ship the release.");
  await page.evaluate(() => (window as any).__MOCK_EMIT__("morning-focus:enabled-changed", false));
  await expect(bubble).not.toContainText("Ship the release.");
  await expect(bubble.getByRole("listitem")).toHaveText("Call the customer");
});
