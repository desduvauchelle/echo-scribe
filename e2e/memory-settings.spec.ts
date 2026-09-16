import { expect, test } from "@playwright/test";
import { installTauriMock, recordedCalls } from "./mock";

test("memory preference persists across settings navigation", async ({ page }) => {
  await installTauriMock(page, { onboardingCompleted: true, permissions: { microphone: true, accessibility: true }, speechModelReady: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("checkbox", { name: "Use less memory" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await page.getByRole("button", { name: "Coding Agents", exact: true }).click();
  await page.getByRole("button", { name: "Dictation", exact: true }).click();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  expect((await recordedCalls(page)).filter(c => c.cmd === "set_low_memory_mode").map(c => c.args))
    .toEqual([{ enabled: true }, { enabled: false }]);
});

test("failed memory save preserves the actual value and shows an error", async ({ page }) => {
  await installTauriMock(page, { onboardingCompleted: true, permissions: { microphone: true, accessibility: true }, speechModelReady: true, memorySaveError: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("checkbox", { name: "Use less memory" });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole("alert")).toContainText("Couldn’t save the memory setting");
  await expect(toggle).toBeEnabled();
});
