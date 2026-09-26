import { expect, test } from "@playwright/test";
import { installTauriMock } from "./mock";

const ready = { onboardingCompleted: true, permissions: { microphone: true, accessibility: true }, speechModelReady: true, llmReady: true, projectCount: 2 };

function item(id: string, content: string, projectId: string, capturedAt: Date) {
  const iso = capturedAt.toISOString();
  return { id, content, source: "manual", kind: "note", project_id: projectId, captured_at: iso, created_at: iso, deleted_at: null, confidence: null, classified_by: null, capture_context: null, importance: null };
}

test("project page has one header row, day dividers, and no redundant project pill", async ({ page }) => {
  const now = new Date();
  const earlier = new Date(now.getTime() - 3 * 24 * 3600_000);
  const items = [
    item("i1", "Draft the juicing launch checklist", "project-1", now),
    item("i2", "Call the supplier about cold-press pricing", "project-1", earlier),
  ];
  await installTauriMock(page, ready);
  await page.addInitScript((rows) => {
    const internals = (window as any).__TAURI_INTERNALS__;
    const base = internals.invoke.bind(internals);
    internals.invoke = (cmd: string, args: unknown) => {
      if (cmd === "list_items") return Promise.resolve(rows);
      if (cmd === "count_items_for_project") return Promise.resolve(rows.length);
      return base(cmd, args);
    };
  }, items);
  await page.goto("/");
  await page.locator(".echo-sidebar").getByRole("button", { name: "Project 1", exact: true }).click();

  const ledger = page.getByRole("region", { name: "Project 1" });
  await expect(ledger).toBeVisible();
  await expect(page.getByText("Recent activity")).toHaveCount(0);
  await expect(page.getByText("Most recent")).toHaveCount(0);
  await expect(ledger.locator(".echo-feed-day").first()).toHaveText("Today");
  await expect(ledger.locator(".echo-feed-day")).toHaveCount(2);
  await expect(ledger.getByText("Draft the juicing launch checklist")).toBeVisible();
  // The row pill naming the current project is redundant on its own page.
  await expect(ledger.locator(".rounded-full", { hasText: "Project 1" })).toHaveCount(0);
});
