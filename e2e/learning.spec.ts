import { test, expect } from "@playwright/test";
import { installTauriMock, recordedCalls } from "./mock";

test("speech downloads once alongside only the two permission prompts and survives skipping", async ({ page }) => {
  await installTauriMock(page, { speechDownloadDeferred: true, captureCounts: {} });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Grant access" })).toHaveCount(2);
  await expect(page.getByText("Preparing your voice…")).toBeVisible();
  await page.screenshot({ path: "output/playwright/onboarding-automatic-download.png" });
  await expect(page.getByText("Screen Recording", { exact: true })).not.toBeVisible();
  await expect(page.getByText("Local AI model", { exact: true })).not.toBeVisible();
  await expect.poll(async () => (await recordedCalls(page)).filter((c) => c.cmd === "download_speech_model").length).toBe(1);
  await page.getByRole("button", { name: "Skip setup for now" }).click();
  await expect(page.getByRole("button", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(page.getByText("Preparing your voice…")).toBeVisible();
  await page.evaluate(() => (window as any).__FINISH_SPEECH_DOWNLOAD__());
  await expect(page.getByText("Preparing your voice…")).not.toBeVisible();
  expect((await recordedCalls(page)).filter((c) => c.cmd === "download_speech_model")).toHaveLength(1);
  expect((await recordedCalls(page)).some((c) => c.cmd === "download_llm_model")).toBe(false);
});

test("a failed automatic download offers retry and does not unlock Start", async ({ page }) => {
  await installTauriMock(page, { permissions: { microphone: true, accessibility: true }, speechDownloadError: "offline" });
  await page.goto("/");
  await expect(page.getByText("Speech setup needs another try")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start Tucky" })).toBeDisabled();
  await page.evaluate(() => { (window as any).__MOCK_STATE__.speechDownloadError = null; });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(async () => (await recordedCalls(page)).filter((c) => c.cmd === "download_speech_model").length).toBe(2);
  await expect(page.getByRole("button", { name: "Start Tucky" })).toBeEnabled();
});

test("first practice is a real controlled input, and typing alone does not complete it", async ({ page }) => {
  await installTauriMock(page, { onboardingCompleted: true, speechModelReady: true, captureCounts: {}, permissions: { microphone: true, accessibility: true } });
  await page.goto("/");
  await expect(page.getByText("0 of 3")).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Your practice space" });
  await input.fill("Typed ");
  await expect(page.getByText("There it is!", { exact: false })).not.toBeVisible();
  await input.focus();
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 6));
  await page.evaluate(() => {
    (window as any).__MOCK_EMIT__("voice:self_capture", "practice");
    (document.activeElement as HTMLElement).blur();
    (window as any).__MOCK_EMIT__("voice:self_insert", { id: "practice", text: "and spoken", expires_at: Date.now() + 2000, press_enter: false });
  });
  await expect(input).toHaveValue("Typed and spoken");
  await expect(page.getByText("There it is!", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next: save a thought" })).toBeVisible();
  await expect(page.locator(".echo-practice-success")).toHaveCSS("opacity", "1");
  await expect(page.locator(".echo-practice-confetti i").first()).toHaveCSS("animation-name", "echo-practice-burst");
  await page.screenshot({ path: "output/playwright/practice-success.png" });
  await page.setViewportSize({ width: 800, height: 600 });
  await page.getByRole("button", { name: "Next: save a thought" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Next: save a thought" })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".echo-practice-confetti")).toBeHidden();
  await page.getByRole("button", { name: "Next: save a thought" }).click();
  await expect(page.getByRole("heading", { name: "Save a thought or task" })).toBeVisible();
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page.getByText("1 of 3")).toBeVisible();
  await expect(page.getByText("AI features are off")).not.toBeVisible();
  await expect(page.getByText("Permission missing: Screen Recording")).not.toBeVisible();
  await page.screenshot({ path: "output/playwright/learning-first-win.png" });
  await page.reload();
  await expect(page.getByText("1 of 3")).toBeVisible();
});

test("milestones defer while dictating, persist dismissal, and never replay after reload", async ({ page }) => {
  await installTauriMock(page, { onboardingCompleted: true, speechModelReady: true, captureCounts: { transcriptions: 9 }, permissions: { microphone: true, accessibility: true } });
  await page.goto("/");
  await expect(page.getByText("1 of 3")).toBeVisible();
  await page.evaluate(() => {
    (window as any).__MOCK_EMIT__("voice:recording_started");
    (window as any).__MOCK_STATE__.captureCounts.transcriptions = 10;
    (window as any).__MOCK_EMIT__("item:created");
  });
  await expect(page.getByText("10 dictations. Look at you go!")).not.toBeVisible();
  await page.evaluate(() => (window as any).__MOCK_EMIT__("voice:paste_dispatched"));
  await expect(page.getByText("10 dictations. Look at you go!")).toBeVisible();
  await page.screenshot({ path: "output/playwright/learning-celebration.png" });
  await page.getByRole("button", { name: "Dismiss celebration" }).click();
  await page.reload();
  await expect(page.getByText("10 dictations. Look at you go!")).not.toBeVisible();
  await page.getByRole("button", { name: "Learn Tucky", exact: true }).click();
  await expect(page.getByRole("region", { name: "Your wins" })).toBeVisible();
  for (const width of [800, 1094]) {
    await page.setViewportSize({ width, height: 650 });
    expect(await page.locator("main").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: "output/playwright/learning-library.png" });
});

test("a contextual lesson opens its actual settings page", async ({ page }) => {
  await installTauriMock(page, { onboardingCompleted: true, speechModelReady: true, captureCounts: { transcriptions: 100 }, permissions: { microphone: true, accessibility: true } });
  await page.goto("/");
  await page.getByRole("button", { name: "Learn Tucky", exact: true }).click();
  await page.getByRole("button", { name: /Say it, then shape it/ }).click();
  await page.getByRole("button", { name: "Set up smart features" }).click();
  await expect(page.getByRole("heading", { name: "Language model", exact: true })).toBeVisible();
});

test("searching and opening a saved capture completes the third step", async ({ page }) => {
  await installTauriMock(page, { onboardingCompleted: true, speechModelReady: true, llmReady: true, captureCounts: { transcriptions: 1, notes: 1 }, permissions: { microphone: true, accessibility: true } });
  await page.goto("/");
  await expect(page.getByText("2 of 3")).toBeVisible();
  await page.evaluate(() => {
    const api = (window as any).__TAURI_INTERNALS__;
    const original = api.invoke;
    const item = { id: "first-note", content: "Proposal for tomorrow", source: "log_capture", kind: "note", project_id: null, captured_at: new Date().toISOString(), created_at: new Date().toISOString(), deleted_at: null, confidence: null, classified_by: null, capture_context: null };
    api.invoke = (cmd: string, args: unknown) => {
      if (cmd === "search_items") return Promise.resolve([item]);
      if (cmd === "get_item") return Promise.resolve(item);
      return original(cmd, args);
    };
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Search my captures" }).click();
  await page.getByRole("textbox", { name: "Search captures", exact: true }).fill("proposal");
  await expect(page.getByText("2 of 3")).toBeVisible();
  await page.getByRole("button", { name: "Open note: Proposal for tomorrow" }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("echo.learning.v1")!).retrieved)).toBe(true);
});
