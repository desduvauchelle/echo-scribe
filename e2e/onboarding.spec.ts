import { test, expect } from "@playwright/test";
import { installTauriMock, mockState, recordedCalls } from "./mock";

// First-run onboarding flow, driven through the real built frontend with a
// mocked Tauri backend (e2e/mock.ts). These are the states a fresh user can
// land in — the class of bug that otherwise ships silently because we've
// all long since completed onboarding on our own machines.

const startButton = /Start Echo Scribe/;
const welcome = /Welcome to Echo Scribe/;

test("fresh install boots into onboarding with Start disabled", async ({ page }) => {
  await installTauriMock(page); // everything ungranted, no models
  await page.goto("/");

  await expect(page.getByText(welcome)).toBeVisible();
  await expect(page.getByRole("button", { name: startButton })).toBeDisabled();
});

test("mic + accessibility + speech model unlock Start (screen recording, calendar, LLM stay optional)", async ({ page }) => {
  await installTauriMock(page, {
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
  });
  await page.goto("/");

  await expect(page.getByText(welcome)).toBeVisible();
  await expect(page.getByRole("button", { name: startButton })).toBeEnabled();
});

test("clicking Start launches the pipeline, persists the flag, and lands on the dashboard", async ({ page }) => {
  await installTauriMock(page, {
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
  });
  await page.goto("/");

  await page.getByRole("button", { name: startButton }).click();
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible();

  const calls = await recordedCalls(page);
  expect(calls.some((c) => c.cmd === "start_pipeline")).toBe(true);
  const setFlag = calls.find((c) => c.cmd === "set_onboarding_completed");
  expect(setFlag?.args).toMatchObject({ completed: true });
});

test("pipeline failure keeps the user on onboarding with an error, without persisting the flag", async ({ page }) => {
  await installTauriMock(page, {
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    startPipelineError: "model files corrupted",
  });
  await page.goto("/");

  await page.getByRole("button", { name: startButton }).click();
  await expect(page.getByText(/model files corrupted/)).toBeVisible();
  await expect(page.getByText(welcome)).toBeVisible();

  const state = await mockState(page);
  expect(state.onboardingCompleted).toBe(false);
});

test("completed onboarding + revoked permission re-enters onboarding with a resume notice", async ({ page }) => {
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: false, accessibility: true },
    speechModelReady: true,
  });
  await page.goto("/");

  await expect(page.getByText(welcome)).toBeVisible();
  await expect(page.getByText(/Continue setup — missing: microphone/)).toBeVisible();
});

test("completed onboarding with preconditions intact boots straight to the dashboard", async ({ page }) => {
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
  });
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText(welcome)).not.toBeVisible();
});
