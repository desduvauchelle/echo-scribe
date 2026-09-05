import { expect, test } from "@playwright/test";
import { installTauriMock, recordedCalls } from "./mock";

const mark = {
  id: "person-mark",
  name: "Mark",
  email: "mark@example.com",
  role: "Founder",
  company_id: "company-echo",
  notes: "Met at the product review.",
  created_at: "2026-07-30T12:00:00Z",
  updated_at: "2026-07-30T12:00:00Z",
};

const echo = {
  id: "company-echo",
  name: "Tucky",
  domain: "echo-scribe.app",
  notes: "Local-first transcription.",
  created_at: "2026-07-30T12:00:00Z",
  updated_at: "2026-07-30T12:00:00Z",
};

test.beforeEach(async ({ page }) => {
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    people: [mark],
    companies: [echo],
  });
  await page.goto("/");
  await page.getByRole("button", { name: "People & companies" }).click();
  await page.getByRole("button", { name: /Mark/ }).click();
});

test("edits a contact and keeps the updated record selected", async ({ page }) => {
  await page.getByRole("button", { name: "Edit contact" }).click();
  await page.getByLabel("Name").fill("Mark Jensen");
  await page.getByLabel("Role").fill("CEO");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByRole("heading", { name: "Mark Jensen" })).toBeVisible();
  await expect(page.locator("main p").filter({ hasText: /^CEO$/ })).toBeVisible();

  const calls = await recordedCalls(page);
  expect(calls.find((call) => call.cmd === "save_person")?.args).toMatchObject({
    id: "person-mark",
    name: "Mark Jensen",
    role: "CEO",
  });
});

test("requires confirmation before deleting a contact", async ({ page }) => {
  await page.getByRole("button", { name: "Delete contact" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete Mark?" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Mark" })).toBeVisible();

  await page.getByRole("button", { name: "Delete contact" }).click();
  await page.getByRole("alertdialog", { name: "Delete Mark?" }).getByRole("button", { name: "Delete" }).click();

  await expect(page.getByRole("heading", { name: "Select a relationship" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Mark/ })).toHaveCount(0);
  const calls = await recordedCalls(page);
  expect(calls.some((call) => call.cmd === "delete_person" && call.args.id === "person-mark")).toBe(true);
});
