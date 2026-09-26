import { expect, test } from "@playwright/test";
import { installTauriMock } from "./mock";

const ready = { onboardingCompleted: true, permissions: { microphone: true, accessibility: true }, speechModelReady: true, llmReady: true };

test("Learn Tucky can be hidden from the sidebar and restored from Settings", async ({ page }) => {
  await installTauriMock(page, ready);
  await page.goto("/");
  const sidebar = page.locator(".echo-sidebar");
  const learn = sidebar.getByRole("button", { name: "Learn Tucky", exact: true });
  await expect(learn).toBeVisible();

  await learn.hover();
  const hide = sidebar.getByRole("button", { name: "Hide Learn Tucky" });
  await expect(hide).toBeVisible();
  await hide.click();
  await expect(learn).toHaveCount(0);
  // Hiding must not navigate to the Learn page.
  await expect(page.getByRole("heading", { name: "Learn Tucky" })).toHaveCount(0);

  // Persists across reloads.
  await page.reload();
  await expect(sidebar.getByRole("button", { name: "Learn Tucky", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".echo-settings-nav").getByRole("button", { name: "General" }).click();
  const toggle = page.getByRole("checkbox", { name: /Show Learn Tucky in sidebar/ });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();

  await page.reload();
  await expect(page.locator(".echo-sidebar").getByRole("button", { name: "Learn Tucky", exact: true })).toBeVisible();
});
