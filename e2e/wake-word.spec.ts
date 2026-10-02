import { expect, test } from "@playwright/test";
import { installTauriMock, recordedCalls } from "./mock";

test("wake listening is opt-in, reflects busy state, and can be paused", async ({ page }) => {
  await installTauriMock(page, { onboardingCompleted: true, speechModelReady: true, permissions: { microphone: true, accessibility: true } });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Tucky command", exact: true }).click();
  const toggle = page.getByRole("checkbox", { name: /Listen for “Tucky”/ });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(page.getByText(/“Hey Tucky, start dictating.” Wait for the new recording cue/)).toBeVisible();
  await expect(page.getByText(/For a specific window, say/)).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Listening for “Tucky”" })).toBeVisible();
  await page.evaluate(() => (window as any).__MOCK_EMIT__("wakeword:status", { enabled: true, state: "paused", message: "Paused while Tucky is busy" }));
  await expect(toggle).toBeChecked();
  await expect(page.getByText("Paused while Tucky is busy", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 720, height: 800 });
  await page.screenshot({ path: "output/playwright/wake-word-settings.png", fullPage: true });
  await toggle.uncheck();
  await expect(page.getByText("Wake word is off", { exact: true })).toBeVisible();
  expect((await recordedCalls(page)).filter(c => c.cmd === "set_wake_word_enabled").map(c => c.args))
    .toEqual([{ enabled: true }, { enabled: false }]);
});

test("failed enable keeps listening off and allows retry", async ({ page }) => {
  await installTauriMock(page, { onboardingCompleted: true, speechModelReady: true, permissions: { microphone: true, accessibility: true }, wakeWordSaveError: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Tucky command", exact: true }).click();
  const toggle = page.getByRole("checkbox", { name: /Listen for “Tucky”/ });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(page.getByRole("alert").filter({ hasText: "Couldn’t change wake-word listening" })).toContainText("Microphone access is required");
});
