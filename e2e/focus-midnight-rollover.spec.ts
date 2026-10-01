import { expect, test } from "@playwright/test";
import { installTauriMock } from "./mock";

test.use({ timezoneId: "America/Los_Angeles" });

for (const trigger of ["midnight", "resume"] as const) {
  test(`dashboard clears prior-day completions on ${trigger} while unfinished tasks remain`, async ({ page }) => {
    await page.clock.install({ time: new Date("2026-10-01T06:59:58Z") });
    await installTauriMock(page, {
      onboardingCompleted: true, permissions: { microphone: true, accessibility: true },
      speechModelReady: true,
    });
    // Simulate the date-aware backend response, testing the real board's refresh.
    await page.addInitScript(() => {
      const original = (window as any).__TAURI_INTERNALS__.invoke;
      (window as any).__TAURI_INTERNALS__.invoke = (cmd: string, args: unknown) => {
        if (cmd !== "list_focus_tasks") return original(cmd, args);
        const item = (id: string, content: string) => ({
          id, content, project_id: null, source: "log_capture", kind: "task",
          captured_at: "2026-09-30T15:00:00Z", created_at: "2026-09-30T15:00:00Z",
          deleted_at: null, confidence: 1, classified_by: "user", capture_context: null, importance: null,
        });
        const rows = [{ item: item("open", "Carry unfinished focus forward"), completed_at: null as string | null, focus_rank: 1 }];
        if (new Date().getDate() === 30) rows.push({
          item: item("done", "Finished focus today"), completed_at: "2026-09-30T20:00:00Z", focus_rank: 2,
        });
        return Promise.resolve(rows);
      };
    });
    await page.goto("/");
    const board = page.locator(".echo-focus-board");
    await expect(board.getByRole("checkbox", { name: "Finished focus today" })).toBeChecked();
    await expect(board.getByRole("checkbox", { name: "Carry unfinished focus forward" })).not.toBeChecked();
    if (trigger === "midnight") {
      await page.clock.runFor(3_000);
    } else {
      await page.clock.setSystemTime(new Date("2026-10-01T07:05:00Z"));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    }
    await expect(board.getByRole("checkbox", { name: "Finished focus today" })).toHaveCount(0);
    await expect(board.getByRole("checkbox", { name: "Carry unfinished focus forward" })).toBeVisible();
  });
}

test("prior-day completed tasks keep their Focus tag in task details", async ({ page }) => {
  const item = {
    id: "historical-focus", content: "Previously completed focused task", project_id: null,
    source: "log_capture", kind: "task", captured_at: "2026-09-30T15:00:00Z",
    created_at: "2026-09-30T15:00:00Z", deleted_at: null, confidence: 1,
    classified_by: "user", capture_context: null, importance: null,
  };
  await installTauriMock(page, {
    onboardingCompleted: true, permissions: { microphone: true, accessibility: true },
    speechModelReady: true, feedItems: [item], focusTaskIds: [item.id],
    tasks: [{ item, deadline: null, completed_at: "2026-09-30T20:00:00Z" }],
  });
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
      const result = await original(cmd, args);
      if (cmd !== "list_focus_tasks") return result;
      return args?.includeCompletedHistory
        ? result.map((row: any) => ({ ...row, completed_at: "2026-09-30T20:00:00Z" }))
        : [];
    };
  });
  await page.goto("/");
  await expect(page.locator(".echo-focus-board").getByRole("checkbox", { name: item.content })).toHaveCount(0);
  await page.getByRole("button", { name: `Open task: ${item.content}`, exact: true }).click();
  await expect(page.getByRole("dialog", { name: item.content }).getByRole("checkbox", { name: "Focus" })).toBeChecked();
});
