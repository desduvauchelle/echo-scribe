import { expect, test } from "@playwright/test";
import { installTauriMock } from "./mock";

const ready = { onboardingCompleted: true, permissions: { microphone: true, accessibility: true }, speechModelReady: true, llmReady: true };

test("greeting can change and stay hidden without removing activity categories or stats", async ({ page }) => {
  await installTauriMock(page, ready);
  await page.goto("/");
  const greeting = page.getByRole("region", { name: "A moment with Tucky" });
  await expect(greeting).toBeVisible();
  const title = await greeting.getByRole("heading").innerText();
  await greeting.getByRole("button", { name: "Another thought" }).click();
  await expect(greeting.getByRole("heading")).not.toHaveText(title);
  await greeting.getByRole("button", { name: "Hide greeting" }).click();
  await expect(greeting).toHaveCount(0);
  await page.reload();
  await expect(greeting).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Activity statistics" })).toBeVisible();
  for (const name of ["Dictations", "Notes", "Tasks", "Meetings", "Recordings"]) {
    await expect(page.locator(".echo-filter-toolbar").getByRole("button", { name, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Show Tucky’s greeting" }).click();
  await expect(greeting).toBeVisible();
  await page.screenshot({ path: "test-results/tucky-dashboard.png" });
  await page.locator(".echo-toolbar-search").click();
  await expect(page.getByRole("textbox", { name: "Search captures", exact: true })).toBeVisible();
});

test("settings retains its navigation and uses the same readable brand treatment", async ({ page }) => {
  await installTauriMock(page, ready);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator(".tucky-settings-heading .tucky-peeking")).toBeVisible();
  await expect(page.locator(".echo-settings-nav .echo-nav-item").first()).toBeVisible();
  const weight = await page.locator(".echo-settings-nav .echo-nav-item").first().evaluate((node) => getComputedStyle(node).fontWeight);
  expect(Number(weight)).toBeGreaterThanOrEqual(500);
  await page.screenshot({ path: "test-results/tucky-settings.png" });
});

test("onboarding illustration preserves setup gating at a short window height", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await installTauriMock(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome to Tucky" })).toBeVisible();
  await expect(page.locator(".tucky-onboarding-card .tucky-peeking")).toBeVisible();
  await expect(page.getByRole("button", { name: /Start Tucky/ })).toBeDisabled();
  const bounds = await page.locator(".tucky-onboarding-card .tucky-peeking").boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  await page.getByRole("button", { name: /Skip setup for now/ }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: /Skip setup for now/ })).toBeVisible();
  await page.screenshot({ path: "test-results/tucky-onboarding.png", fullPage: true });
});


test("dark branding keeps the mascot and navigation readable", async ({ page }) => {
  await installTauriMock(page, ready);
  await page.addInitScript(() => localStorage.setItem("echoScribe.themePref", "dark"));
  await page.goto("/");
  await expect(page.locator(".tucky-peeking-dark")).toBeVisible();
  await expect(page.locator(".tucky-peeking-light")).toBeHidden();
  await expect(page.locator(".echo-sidebar .echo-nav-item").first()).toBeVisible();
  await page.screenshot({ path: "test-results/tucky-dashboard-dark.png" });
});
