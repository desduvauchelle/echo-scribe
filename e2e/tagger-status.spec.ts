import { expect, test } from "@playwright/test";
import { installTauriMock } from "./mock";

test("background tagging is visible on opening the dashboard and can be stopped", async ({ page }) => {
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    llmReady: true,
  });
  await page.addInitScript(() => {
    const w = window as any;
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAG_STATUS__ = { running: true, stopping: false, paused: false, processed: 3, total: 25, assigned: 2 };
    w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: unknown) => {
      if (cmd === "get_project_tagger_status") return { ...w.__TAG_STATUS__ };
      if (cmd === "stop_project_tagger") {
        w.__TAG_STATUS__.stopping = true;
        w.__TAG_STATUS__.paused = true;
        return { ...w.__TAG_STATUS__ };
      }
      if (cmd === "run_project_tagger_all") {
        w.__TAG_STATUS__ = { running: true, stopping: false, paused: false, processed: 0, total: 25, assigned: 0 };
        return new Promise(resolve => { w.__FINISH_TAGGING__ = resolve; });
      }
      return original(cmd, args);
    };
  });
  await page.goto("/");
  const stop = page.getByRole("button", { name: "Stop tagging", exact: true });
  await expect(stop).toBeVisible();
  await expect(stop.locator(".animate-spin")).toBeVisible();
  await expect(stop).toContainText("3");
  await expect(page.getByRole("button", { name: "Add a focus task" })).toHaveCount(0);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(stop).toBeVisible();
  await page.screenshot({ path: "/tmp/tucky-tagging-loading.png" });
  await page.setViewportSize({ width: 500, height: 700 });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(page.getByRole("button", { name: "Stopping tagging…" })).toBeDisabled();
  await page.evaluate(() => { (window as any).__TAG_STATUS__.running = false; (window as any).__TAG_STATUS__.stopping = false; });
  await expect(page.getByRole("button", { name: "Resume tagging" })).toBeEnabled();
  await page.getByRole("button", { name: "Resume tagging" }).click();
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect(page.getByRole("button", { name: "Stopping tagging…" })).toBeDisabled();
  await page.evaluate(() => {
    const w = window as any;
    w.__TAG_STATUS__.running = false;
    w.__TAG_STATUS__.stopping = false;
    w.__FINISH_TAGGING__({ cancelled: true, scanned: 0, assigned: 0, deferred: 0, failed: 0, sample_error: null });
  });
  await expect(page.getByRole("button", { name: "Resume tagging" })).toBeEnabled();
  await expect(page.getByText("Tagging ran — everything already has a project.")).toHaveCount(0);
});
