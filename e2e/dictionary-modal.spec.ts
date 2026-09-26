import { expect, test } from "@playwright/test";
import { installTauriMock } from "./mock";

test("dictation dictionary opens in a scrollable modal and keeps editing available", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 620 });
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    dictionaryEntries: Array.from({ length: 24 }, (_, index) => ({
      spoken_form: `heard ${index}`,
      replacement: `written ${index}`,
      language: "auto",
    })),
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  await expect(page.getByRole("button", { name: "Manage dictionary" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Dictionary" })).toHaveCount(0);
  await page.getByRole("button", { name: "Manage dictionary" }).click();
  const dialog = page.getByRole("dialog", { name: "Dictionary" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("heard 23")).toBeVisible();
  const list = dialog.locator(".overflow-y-auto");
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.setViewportSize({ width: 520, height: 620 });
  const modalWidth = await dialog.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    scrollWidth: element.scrollWidth,
  }));
  expect(modalWidth.scrollWidth).toBeLessThanOrEqual(modalWidth.width + 1);

  await dialog.getByRole("textbox", { name: "Search dictionary" }).fill("heard 23");
  await expect(dialog.getByText("heard 23")).toBeVisible();
  await expect(dialog.getByText("heard 22")).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "Search dictionary" }).clear();
  await dialog.getByRole("textbox", { name: "What Tucky hears" }).fill("grilling");
  await dialog.getByRole("textbox", { name: "Replace with" }).fill("grilling correctly");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog.getByText("grilling correctly")).toBeVisible();
  await dialog.getByRole("button", { name: "Remove" }).last().click();
  await expect(dialog.getByText("grilling correctly")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage dictionary" })).toBeFocused();
});
