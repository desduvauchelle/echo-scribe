import { expect, test } from "@playwright/test";
import { installTauriMock } from "./mock";

test("dashboard stats switch categories and open the detailed view", async ({ page }) => {
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
  });
  await page.goto("/");

  const overview = page.getByRole("region", { name: "Activity statistics" });
  await expect(page.getByRole("tablist", { name: "Activity type" })).toHaveCount(0);
  await expect(overview.getByText("Dictations", { exact: true })).toBeVisible();
  await expect(overview.getByText("Notes", { exact: true })).toBeVisible();
  await expect(overview.getByText("Tasks", { exact: true })).toBeVisible();
  await expect(overview.getByText("Meetings", { exact: true })).toBeVisible();
  await expect(overview.getByText("Recordings", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await expect(page.getByText("Time this week")).toBeVisible();
  await overview.getByRole("button", { name: "View stats" }).click();

  await expect(page.getByRole("heading", { name: "Stats" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Last 7 days" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "90-day rhythm" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Meetings" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // The back button must return to the dashboard.
  await page.getByRole("button", { name: "Back to dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Stats" })).toHaveCount(0);
  await expect(overview.getByText("Dictations", { exact: true })).toBeVisible();
});
