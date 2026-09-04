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

// Drive the same IPC event emitted by persist_capture after a saved dictation.
async function updateDictationCount(page: import("@playwright/test").Page, count: number, event: string) {
  await page.evaluate(({ count, event }) => {
    const w = window as any;
    w.__DICTATION_COUNT__ = count;
    w.__MOCK_EMIT__(event);
  }, { count, event });
}

for (const detailed of [false, true]) {
  test(`${detailed ? "detailed stats" : "dashboard"} refreshes dictation counts while open`, async ({ page }) => {
    await installTauriMock(page, {
      onboardingCompleted: true,
      permissions: { microphone: true, accessibility: true },
      speechModelReady: true,
    });
    await page.addInitScript(() => {
      const w = window as any;
      w.__DICTATION_COUNT__ = 43;
      const invoke = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: unknown) => {
        const result = await invoke(cmd, args);
        if (cmd === "get_dashboard_stats") {
          result.categories.transcriptions.today.count = w.__DICTATION_COUNT__;
        }
        return result;
      };
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Dictations", exact: true }).click();
    const overview = page.getByRole("region", { name: "Activity statistics" });
    if (detailed) await overview.getByRole("button", { name: "View stats" }).click();
    const today = page.getByText("43", { exact: true });
    await expect(today).toBeVisible();
    await updateDictationCount(page, 200, "item:created");
    await expect(page.getByText("200", { exact: true })).toBeVisible();
    await updateDictationCount(page, 199, "app:refresh");
    await expect(page.getByText("199", { exact: true })).toBeVisible();
  });
}
