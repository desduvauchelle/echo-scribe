import { expect, test } from "@playwright/test";
import { installTauriMock } from "./mock";

test("closed slide-over panels do not cast a shadow into the app", async ({ page }) => {
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
  });
  await page.goto("/");

  const closedPanelShadows = await page.locator('aside[role="dialog"]').evaluateAll(
    (panels) => panels.map((panel) => getComputedStyle(panel).boxShadow),
  );

  // Tailwind serializes `shadow-none` as transparent layers in Chromium, so
  // assert the visual invariant rather than the literal CSS spelling.
  expect(closedPanelShadows).not.toContainEqual(expect.stringMatching(/0\.25/));
});
