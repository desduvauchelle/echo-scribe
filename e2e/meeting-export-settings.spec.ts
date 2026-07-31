import { expect, test } from "@playwright/test";
import { installTauriMock, recordedCalls } from "./mock";

test("meeting export folder can be cleared and selected", async ({ page }) => {
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    meetingExportFolder: "/Users/test/Old Meetings",
    pickedExportFolder: "/Users/test/Meeting Notes",
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Dictation", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Meetings", exact: true }),
  ).toBeVisible();

  const section = page.getByRole("heading", { name: "Meeting notes folder" }).locator("..");
  await expect(section).toContainText("/Users/test/Old Meetings");
  await section.getByRole("button", { name: "Clear" }).click();
  await expect(section.getByRole("button", { name: "Choose folder…" })).toBeVisible();

  await section.getByRole("button", { name: "Choose folder…" }).click();
  await expect(section).toContainText("/Users/test/Meeting Notes");

  const calls = await recordedCalls(page);
  expect(
    calls.filter(({ cmd }) => cmd === "set_meeting_export_folder").map(({ args }) => args),
  ).toEqual([
    { folder: null },
    { folder: "/Users/test/Meeting Notes" },
  ]);
});
