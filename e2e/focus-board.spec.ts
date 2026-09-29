import { expect, test, type Page } from "@playwright/test";
import { installTauriMock } from "./mock";

// Optional screenshots for design review: FOCUS_SHOTS=/some/dir bun run test:e2e focus
const SHOTS = process.env.FOCUS_SHOTS;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.locator(".echo-focus-board").screenshot({ path: `${SHOTS}/${name}.png` });
};

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) => ((window as any).__MOCK_CALLS__ as { cmd: string; args: any }[]).filter((x) => x.cmd === c),
    cmd,
  );

const rowTexts = (page: Page, project: string) =>
  page.locator(`[data-focus-group="${project}"] [data-focus-row] span.ml-1`).allTextContents();

async function addVia(page: Page, texts: string[]) {
  const input = page.locator(".echo-focus-board input");
  for (const t of texts) {
    await input.fill(t);
    await input.press("Enter");
  }
  await input.press("Escape");
}

test("focus board: add, edit, complete, reorder and remove persist through the backend", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    llmReady: true,
    projectCount: 3,
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Add a focus task" })).toHaveCount(0);
  // Initial focus can arrive from the assistant; the board retains its own add controls.
  await page.evaluate(async () => {
    await (window as any).__TAURI_INTERNALS__.invoke("add_focus_task", { projectId: "project-1", content: "Ship the onboarding rewrite" });
    (window as any).__MOCK_EMIT__("focus:changed", null);
  });
  const board = page.locator(".echo-focus-board");
  await page.getByRole("button", { name: "Add item to Project 1" }).click();
  await addVia(page, ["Fix the capture crash", "Record the promo"]);
  // A Tucky-created task can add another project to the board.
  await page.evaluate(async () => {
    await (window as any).__TAURI_INTERNALS__.invoke("add_focus_task", { projectId: "project-2", content: "Close the partnership deal" });
    (window as any).__MOCK_EMIT__("focus:changed", null);
  });
  await expect(board.getByRole("heading", { name: "Focus" })).toBeVisible();
  await expect(board.getByText("What matters per project")).toHaveCount(0);
  await expect(board.getByText(/\d+\/\d+ done/)).toHaveCount(0);
  await expect(board.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
  expect(await rowTexts(page, "project-1")).toEqual([
    "Ship the onboarding rewrite",
    "Fix the capture crash",
    "Record the promo",
  ]);
  expect((await calls(page, "add_focus_task")).map((c) => c.args.projectId)).toEqual([
    "project-1", "project-1", "project-1", "project-2",
  ]);
  // Projects without focus items get no card.
  await expect(page.locator('[data-focus-group="project-3"]')).toHaveCount(0);

  // The per-card "+" sits in the card header.
  await page.getByRole("button", { name: "Add item to Project 2" }).click();
  await addVia(page, ["Draft pricing copy"]);
  expect(await rowTexts(page, "project-2")).toEqual(["Close the partnership deal", "Draft pricing copy"]);
  await shot(page, "2-filled");
  const firstGroup = page.locator('[data-focus-group="project-1"]');
  const secondGroup = page.locator('[data-focus-group="project-2"]');
  const wideFirst = (await firstGroup.boundingBox())!;
  const wideSecond = (await secondGroup.boundingBox())!;
  expect(wideSecond.x).toBeGreaterThan(wideFirst.x + wideFirst.width);
  expect(wideSecond.x - (wideFirst.x + wideFirst.width)).toBeGreaterThanOrEqual(40);
  await page.setViewportSize({ width: 500, height: 1000 });
  const narrowFirst = (await firstGroup.boundingBox())!;
  const narrowSecond = (await secondGroup.boundingBox())!;
  expect(narrowSecond.y).toBeGreaterThan(narrowFirst.y + narrowFirst.height);
  await page.setViewportSize({ width: 1280, height: 1000 });

  // Double-click to edit.
  await page.locator("[data-focus-row]", { hasText: "Fix the capture crash" }).locator("span.ml-1").dblclick();
  await board.locator("input").fill("Fix the window-capture crash");
  await shot(page, "3-editing");
  await board.locator("input").press("Enter");
  expect((await calls(page, "update_item")).at(-1)?.args.args).toMatchObject({
    content: "Fix the window-capture crash",
  });

  // Tick done.
  await page.getByRole("checkbox", { name: "Record the promo" }).click();
  expect((await calls(page, "complete_task")).length).toBe(1);

  // Drag "Record the promo" to the top of Project 1.
  const row = (t: string) => page.locator("[data-focus-row]", { hasText: t });
  await row("Record the promo").hover();
  const grip = (await row("Record the promo").getByRole("button", { name: /Drag to reorder/ }).boundingBox())!;
  const top = (await row("Ship the onboarding rewrite").boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 4, top.y + 3, { steps: 8 });
  await shot(page, "4-dragging");
  await page.mouse.up();
  expect(await rowTexts(page, "project-1")).toEqual([
    "Record the promo",
    "Ship the onboarding rewrite",
    "Fix the window-capture crash",
  ]);

  // Drag "Draft pricing copy" across into Project 1's card (bottom).
  await row("Draft pricing copy").hover();
  const g2 = (await row("Draft pricing copy").getByRole("button", { name: /Drag to reorder/ }).boundingBox())!;
  const last = (await row("Fix the window-capture crash").boundingBox())!;
  await page.mouse.move(g2.x + 4, g2.y + 4);
  await page.mouse.down();
  await page.mouse.move(last.x + 20, last.y + last.height + 2, { steps: 10 });
  await page.mouse.up();
  expect(await rowTexts(page, "project-1")).toContain("Draft pricing copy");
  const lastOrder = (await calls(page, "reorder_focus_tasks")).at(-1)!.args.order as {
    item_id: string;
    project_id: string | null;
  }[];
  expect(lastOrder.every((o) => o.project_id === "project-1" || o.project_id === "project-2")).toBe(true);
  expect(lastOrder.filter((o) => o.project_id === "project-1")).toHaveLength(4);

  // Remove.
  await row("Close the partnership deal").hover();
  await row("Close the partnership deal").getByRole("button", { name: "Remove" }).click();
  expect((await calls(page, "delete_item")).length).toBe(1);
  // Project 2 is now empty → its card disappears.
  await expect(page.locator('[data-focus-group="project-2"]')).toHaveCount(0);
  const singleGroup = (await firstGroup.boundingBox())!;
  expect(singleGroup.width).toBeLessThan(wideFirst.width + wideSecond.width);

  // The board reloads from the backend on focus:changed (e.g. a Tucky
  // command) — what's shown must match what was stored.
  const before = await rowTexts(page, "project-1");
  await page.evaluate(() => (window as any).__MOCK_EMIT__("focus:changed", null));
  await expect.poll(() => rowTexts(page, "project-1")).toEqual(before);
  await page.mouse.move(0, 0);
  await shot(page, "5-final");
});

test("focus board shows four tasks until expanded and aligns the checkbox with text", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    projectCount: 1,
  });
  await page.goto("/");
  await page.evaluate(async () => {
    for (let index = 1; index <= 6; index++) {
      await (window as any).__TAURI_INTERNALS__.invoke("add_focus_task", {
        projectId: "project-1",
        content: `Focus item ${index}`,
      });
    }
    (window as any).__MOCK_EMIT__("focus:changed", null);
  });
  const group = page.locator('[data-focus-group="project-1"]');
  await expect(group.locator("[data-focus-row]")).toHaveCount(4);
  await expect(group.getByText(/\d+\/\d+/)).toHaveCount(0);
  const first = group.locator("[data-focus-row]").first();
  const checkbox = (await first.getByRole("checkbox").boundingBox())!;
  const label = (await first.locator("span.ml-1").boundingBox())!;
  expect(Math.abs(checkbox.y - label.y)).toBeLessThanOrEqual(1);

  await group.getByRole("button", { name: "Show 2 more" }).click();
  await expect(group.locator("[data-focus-row]")).toHaveCount(6);
  await group.getByRole("button", { name: "Show less" }).click();
  await expect(group.locator("[data-focus-row]")).toHaveCount(4);
  await page.setViewportSize({ width: 500, height: 700 });
  await expect(group.getByRole("button", { name: "Show 2 more" })).toBeVisible();
});

test("focus section disappears when its last task is removed", async ({ page }) => {
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    llmReady: true,
  });
  await page.goto("/");
  await page.evaluate(async () => {
    await (window as any).__TAURI_INTERNALS__.invoke("add_focus_task", { projectId: null, content: "Finish one thing" });
    (window as any).__MOCK_EMIT__("focus:changed", null);
  });
  const board = page.locator(".echo-focus-board");
  await expect(board).toContainText("Finish one thing");
  await board.locator("[data-focus-row]").hover();
  await board.getByRole("button", { name: "Remove" }).click();
  await expect(board).toHaveCount(0);
});

test("focus task eye opens the existing activity detail view", async ({ page }) => {
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    projectCount: 1,
  });
  await page.goto("/");
  await page.evaluate(async () => {
    await (window as any).__TAURI_INTERNALS__.invoke("add_focus_task", { projectId: "project-1", content: "Prepare launch notes" });
    (window as any).__MOCK_EMIT__("focus:changed", null);
  });
  const board = page.locator(".echo-focus-board");

  const row = board.locator("[data-focus-row]").first();
  await row.hover();
  const eye = row.getByRole("button", { name: "Open task: Prepare launch notes" });
  await expect(eye).toBeVisible();
  await expect(eye).toHaveCSS("opacity", "1");
  await eye.click();

  const detail = page.getByRole("dialog", { name: "Prepare launch notes" });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("button", { name: "Edit text" })).toBeVisible();
  await expect(detail.getByRole("textbox", { name: "Add tag…" })).toBeVisible();
  await detail.getByRole("button", { name: "Edit text" }).click();
  await detail.getByRole("textbox").first().fill("Prepare updated launch notes");
  await detail.getByRole("textbox").first().press("Enter");
  await expect(row).toContainText("Prepare updated launch notes");
});
