import { expect, test } from "@playwright/test";
import { installTauriMock } from "./mock";

test("task card can turn Focus off and on without changing ordinary tags", async ({ page }) => {
  const item = {
    id: "focused-task",
    content: "Prepare the project brief",
    source: "log_capture",
    kind: "task",
    project_id: "project-1",
    captured_at: "2026-09-25T12:00:00Z",
    created_at: "2026-09-25T12:00:00Z",
    deleted_at: null,
    confidence: 1,
    classified_by: "user",
    capture_context: null,
    importance: null,
  };
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    projectCount: 1,
    feedItems: [item],
    focusTaskIds: [item.id],
    itemTags: { [item.id]: ["urgent"] },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Open task: Prepare the project brief/ }).click();
  const panel = page.getByRole("dialog", { name: "Prepare the project brief" });
  await expect(panel.getByRole("checkbox", { name: "Focus" })).toBeChecked();
  await panel.getByRole("checkbox", { name: "Focus" }).click();
  await expect(panel.getByRole("checkbox", { name: "Focus" })).not.toBeChecked();
  await expect(page.locator('[data-focus-group="project-1"]')).toHaveCount(0);
  await expect(panel.getByText("#urgent")).toBeVisible();
  await panel.getByRole("checkbox", { name: "Focus" }).click();
  await expect(panel.getByRole("checkbox", { name: "Focus" })).toBeChecked();
  await expect(page.locator('[data-focus-group="project-1"]')).toBeVisible();
});
