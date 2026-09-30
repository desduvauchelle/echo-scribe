import { expect, test } from "@playwright/test";
import { installTauriMock } from "./mock";

test("project Tasks includes focused tasks and refreshes when completed elsewhere", async ({ page }) => {
  const item = (id: string, content: string, project_id: string) => ({
    id, content, project_id, source: "log_capture", kind: "task",
    captured_at: "2026-09-25T12:00:00Z", created_at: "2026-09-25T12:00:00Z",
    deleted_at: null, confidence: 1, classified_by: "user", capture_context: null, importance: null,
  });
  const focused = item("focused", "Migrate the project bucket", "project-1");
  const ordinary = item("ordinary", "Plan the campaign", "project-1");
  const other = item("other", "Another project's focus", "project-2");
  await installTauriMock(page, {
    onboardingCompleted: true, permissions: { microphone: true, accessibility: true },
    speechModelReady: true, projectCount: 2,
    feedItems: [focused, ordinary, other], focusTaskIds: [focused.id, other.id],
    tasks: [focused, ordinary, other].map((item) => ({ item, deadline: null, completed_at: null })),
  });
  await page.goto("/");
  await expect(page.locator('[data-focus-group="project-1"]').getByText(focused.content)).toBeVisible();
  await page.locator(".echo-sidebar").getByRole("button", { name: "Project 1", exact: true }).click();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.getByText(focused.content, { exact: true })).toBeVisible();
  await expect(page.getByText(ordinary.content, { exact: true })).toBeVisible();
  await expect(page.getByText(other.content, { exact: true })).toHaveCount(0);
  // The pet and Focus board emit this event after changing the same task.
  await page.evaluate(async () => {
    await (window as any).__TAURI_INTERNALS__.invoke("complete_task", { itemId: "focused" });
    (window as any).__MOCK_EMIT__("focus:changed");
  });
  await expect(page.getByText(focused.content, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page.getByText(focused.content, { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await (window as any).__TAURI_INTERNALS__.invoke("uncomplete_task", { itemId: "focused" });
    (window as any).__MOCK_EMIT__("focus:changed");
  });
  await expect(page.getByText(focused.content, { exact: true })).toHaveCount(1);
  await expect(page.getByText(focused.content, { exact: true })).toBeVisible();
});
