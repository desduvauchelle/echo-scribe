import { expect, test } from "@playwright/test";
import { installTauriMock } from "./mock";

for (const theme of ["light", "dark"] as const) {
  test(`activity and focus bubbles follow ${theme} theme`, async ({ page }) => {
    await page.clock.install({ time: new Date("2026-09-25T10:00:00") });
    await page.addInitScript((value) => localStorage.setItem("echoScribe.themePref", value), theme);
    await page.setViewportSize({ width: 300, height: 76 });
    await installTauriMock(page, { dailyFocusNotes: { "2026-09-25": "Ship the release." } });
    await page.goto("/src/activity-bubble/index.html");
    await expect.poll(async () => {
      await page.evaluate(() => (window as any).__MOCK_EMIT__("show-activity-bubble", { mode: "log-recording" }));
      return page.getByRole("status").count();
    }).toBe(1);
    await expect(page.getByRole("status")).toContainText("Taking notes");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const activityColor = await page.locator(".activity-bubble").evaluate((bubble) => getComputedStyle(bubble).backgroundColor);
    expect(activityColor).toBe(theme === "light" ? "rgb(255, 249, 233)" : "rgb(27, 41, 34)");
    if (process.env.BUBBLE_SHOTS) await page.screenshot({ path: `${process.env.BUBBLE_SHOTS}/activity-${theme}.png` });

    await page.setViewportSize({ width: 300, height: 160 });
    await page.goto("/src/desktop-pet/focus.html");
    await expect(page.getByRole("complementary", { name: "Today's focus" })).toContainText("Ship the release.");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const focusColor = await page.locator(".pet-focus-bubble").evaluate((bubble) => getComputedStyle(bubble).backgroundColor);
    expect(focusColor).toBe(activityColor);
    if (process.env.BUBBLE_SHOTS) await page.screenshot({ path: `${process.env.BUBBLE_SHOTS}/focus-${theme}.png` });
    if (theme === "light") {
      await page.evaluate(() => {
        localStorage.setItem("echoScribe.themePref", "dark");
        window.dispatchEvent(new StorageEvent("storage", { key: "echoScribe.themePref" }));
      });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      expect(await page.locator(".pet-focus-bubble").evaluate((bubble) => getComputedStyle(bubble).backgroundColor)).toBe("rgb(27, 41, 34)");
    }
  });

  test(`confirmation and assistant bubbles follow ${theme} theme`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("echoScribe.themePref", value), theme);
    await installTauriMock(page);
    await page.setViewportSize({ width: 320, height: 82 });
    await page.goto("/src/action-toast/index.html");
    await expect.poll(async () => {
      await page.evaluate(() => (window as any).__MOCK_EMIT__("show-action-toast", { kind: "stay_awake", message: "Keeping your Mac awake" }));
      return page.locator(".action-toast.is-visible").count();
    }).toBe(1);
    await expect(page.locator(".action-toast")).toHaveCSS("opacity", "1");
    const color = theme === "light" ? "rgb(255, 249, 233)" : "rgb(27, 41, 34)";
    expect(await page.locator(".action-toast").evaluate((bubble) => getComputedStyle(bubble).backgroundColor)).toBe(color);
    if (process.env.BUBBLE_SHOTS) await page.screenshot({ path: `${process.env.BUBBLE_SHOTS}/action-${theme}.png` });

    await page.setViewportSize({ width: 360, height: 104 });
    await page.goto("/src/agent-toast/index.html");
    await expect.poll(async () => {
      await page.evaluate(() => (window as any).__MOCK_EMIT__("agent-toast:report", {
        request: "Add a task", status: "running", answer: "", changes: [], sources: [],
      }));
      return page.locator(".agent-toast.is-visible").count();
    }).toBe(1);
    await expect(page.locator(".agent-toast")).toHaveCSS("opacity", "1");
    expect(await page.locator(".agent-toast").evaluate((bubble) => getComputedStyle(bubble).backgroundColor)).toBe(color);
    if (process.env.BUBBLE_SHOTS) await page.screenshot({ path: `${process.env.BUBBLE_SHOTS}/assistant-${theme}.png` });

    await page.setViewportSize({ width: 370, height: 90 });
    await page.goto("/src/meeting-toast/index.html");
    await expect.poll(async () => {
      await page.evaluate(() => (window as any).__MOCK_EMIT__("show-meeting-toast", { app_name: "Zoom" }));
      return page.locator(".meeting-toast.is-visible").count();
    }).toBe(1);
    await expect(page.locator(".meeting-toast")).toHaveCSS("opacity", "1");
    expect(await page.locator(".meeting-toast").evaluate((bubble) => getComputedStyle(bubble).backgroundColor)).toBe(color);
    if (process.env.BUBBLE_SHOTS) await page.screenshot({ path: `${process.env.BUBBLE_SHOTS}/meeting-${theme}.png` });
  });
}
