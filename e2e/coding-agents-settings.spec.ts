import { expect, test } from "@playwright/test";
import { installTauriMock, mockState, recordedCalls } from "./mock";

test("coding agents page lists permissions, toggles them, and shows install snippets", async ({
  page,
}) => {
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Dictation", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Coding Agents", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Tool permissions" }),
  ).toBeVisible();

  // One checkbox per category, defaults mirroring the backend: read-only
  // categories on, screen recording off.
  const permissions = page
    .getByRole("heading", { name: "Tool permissions" })
    .locator("..");
  await expect(permissions.getByRole("checkbox")).toHaveCount(5);
  await expect(
    permissions.getByRole("checkbox", { name: "Screen recording" }),
  ).not.toBeChecked();
  await expect(
    permissions.getByRole("checkbox", { name: "Meetings & transcripts" }),
  ).toBeChecked();

  // Toggling persists through the backend command with the category id.
  await permissions.getByRole("checkbox", { name: "Screen recording" }).check();
  await permissions
    .getByRole("checkbox", { name: "Meetings & transcripts" })
    .uncheck();
  const calls = await recordedCalls(page);
  expect(
    calls
      .filter(({ cmd }) => cmd === "set_mcp_permission")
      .map(({ args }) => args),
  ).toEqual([
    { id: "screen_recording", enabled: true },
    { id: "meetings", enabled: false },
  ]);
  const state = await mockState(page);
  expect(state.mcpPermissions.screen_recording).toBe(true);
  expect(state.mcpPermissions.meetings).toBe(false);

  // Install snippets are built from the backend-reported binary path.
  const connect = page
    .getByRole("heading", { name: "Connect your coding agent" })
    .locator("..");
  await expect(connect).toContainText(
    'claude mcp add echo-scribe -- "/Applications/Echo Scribe.app/Contents/MacOS/echo-scribe" --mcp',
  );
  await expect(connect).toContainText("[mcp_servers.echo_scribe]");
  await expect(connect).toContainText('"mcpServers"');
});
