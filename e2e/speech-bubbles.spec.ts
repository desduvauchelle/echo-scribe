import { expect, test, type Page } from "@playwright/test";
import { installTauriMock } from "./mock";

// Exercise the real cards at their native window sizes, including auto-resize.
async function expectPaintRoom(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(32);
  expect(box.y).toBeGreaterThanOrEqual(28);
  expect(viewport.width - box.x - box.width).toBeGreaterThanOrEqual(32);
  expect(viewport.height - box.y - box.height).toBeGreaterThanOrEqual(44);
}

for (const theme of ["light", "dark"] as const) {
  test(`activity and focus bubbles follow ${theme} theme`, async ({ page }) => {
    await page.clock.install({ time: new Date("2026-09-25T10:00:00") });
    await page.addInitScript((value) => localStorage.setItem("echoScribe.themePref", value), theme);
    await page.setViewportSize({ width: 352, height: 126 });
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
    await expectPaintRoom(page, ".activity-bubble");
    if (process.env.BUBBLE_SHOTS) await page.screenshot({ path: `${process.env.BUBBLE_SHOTS}/activity-${theme}.png` });

    await page.setViewportSize({ width: 355, height: 220 });
    await page.goto("/src/desktop-pet/focus.html");
    await expect(page.getByRole("complementary", { name: "Today's focus" })).toContainText("Ship the release.");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const focusColor = await page.locator(".pet-focus-bubble").evaluate((bubble) => getComputedStyle(bubble).backgroundColor);
    expect(focusColor).toBe(activityColor);
    await expectPaintRoom(page, ".pet-focus-bubble");
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
    await page.setViewportSize({ width: 372, height: 132 });
    await page.goto("/src/action-toast/index.html");
    await expect.poll(async () => {
      await page.evaluate(() => (window as any).__MOCK_EMIT__("show-action-toast", { kind: "stay_awake", message: "Keeping your Mac awake" }));
      return page.locator(".action-toast.is-visible").count();
    }).toBe(1);
    await expect(page.locator(".action-toast")).toHaveCSS("opacity", "1");
    const color = theme === "light" ? "rgb(255, 249, 233)" : "rgb(27, 41, 34)";
    expect(await page.locator(".action-toast").evaluate((bubble) => getComputedStyle(bubble).backgroundColor)).toBe(color);
    await expectPaintRoom(page, ".action-toast");
    if (process.env.BUBBLE_SHOTS) await page.screenshot({ path: `${process.env.BUBBLE_SHOTS}/action-${theme}.png` });

    await page.setViewportSize({ width: 412, height: 154 });
    await page.goto("/src/agent-toast/index.html");
    await expect.poll(async () => {
      await page.evaluate(() => (window as any).__MOCK_EMIT__("agent-toast:report", {
        request: "Add a task", status: "running", answer: "", changes: [], sources: [],
      }));
      return page.locator(".agent-toast.is-visible").count();
    }).toBe(1);
    await expect(page.locator(".agent-toast")).toHaveCSS("opacity", "1");
    expect(await page.locator(".agent-toast").evaluate((bubble) => getComputedStyle(bubble).backgroundColor)).toBe(color);
    const height = await page.evaluate(() => (window as any).__MOCK_CALLS__
      .filter((call: any) => call.cmd === "resize_agent_toast").at(-1).args.height);
    await page.setViewportSize({ width: 412, height });
    await expectPaintRoom(page, ".agent-toast");
    if (process.env.BUBBLE_SHOTS) await page.screenshot({ path: `${process.env.BUBBLE_SHOTS}/assistant-${theme}.png` });

    await page.setViewportSize({ width: 422, height: 140 });
    await page.goto("/src/meeting-toast/index.html");
    await expect.poll(async () => {
      await page.evaluate(() => (window as any).__MOCK_EMIT__("show-meeting-toast", { app_name: "Zoom" }));
      return page.locator(".meeting-toast.is-visible").count();
    }).toBe(1);
    await expect(page.locator(".meeting-toast")).toHaveCSS("opacity", "1");
    expect(await page.locator(".meeting-toast").evaluate((bubble) => getComputedStyle(bubble).backgroundColor)).toBe(color);
    await expectPaintRoom(page, ".meeting-toast");
    if (process.env.BUBBLE_SHOTS) await page.screenshot({ path: `${process.env.BUBBLE_SHOTS}/meeting-${theme}.png` });
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`standalone listening and status overlays follow ${theme} theme`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("echoScribe.themePref", value), theme);
    await installTauriMock(page);
    await page.goto("/src/overlay/index.html");
    const color = theme === "light" ? "rgb(255, 249, 233)" : "rgb(27, 41, 34)";
    for (const mode of ["recording", "log-recording", "action-recording", "transcribing", "processing", "meeting"]) {
      await page.setViewportSize({ width: mode.includes("recording") ? 184 : 340, height: mode.includes("recording") ? 48 : 64 });
      await expect.poll(async () => {
        await page.evaluate((mode) => (window as any).__MOCK_EMIT__("show-overlay",
          mode === "processing" ? { mode, label: "Working" } : mode === "meeting" ? { mode, app_name: "Zoom" } : mode), mode);
        return page.locator(".recording-overlay.fade-in").count();
      }).toBe(1);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("html")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(page.locator(".recording-overlay")).toHaveCSS("background-color", color);
      await expect(page.locator(".recording-overlay")).toHaveCSS("opacity", "1");
      const box = (await page.locator(".recording-overlay").boundingBox())!;
      expect(box.width).toBe(page.viewportSize()!.width);
      expect(box.height).toBe(page.viewportSize()!.height);
      if (mode.includes("recording")) {
        await expect(page.getByRole("button", { name: "Cancel recording" })).toBeVisible();
        await expect(page.locator(".bar")).toHaveCount(16);
      }
      if (mode === "meeting") await expect(page.getByRole("button")).toHaveCount(3);
      if (process.env.BUBBLE_SHOTS) await page.screenshot({ path: `${process.env.BUBBLE_SHOTS}/overlay-${theme}-${mode}.png` });
    }
    // A preference change from another webview must update the open overlay.
    const next = theme === "light" ? "dark" : "light";
    await page.evaluate((value) => {
      localStorage.setItem("echoScribe.themePref", value);
      window.dispatchEvent(new StorageEvent("storage", { key: "echoScribe.themePref" }));
    }, next);
    await expect(page.locator("html")).toHaveAttribute("data-theme", next);
    await expect(page.locator(".recording-overlay")).toHaveCSS("background-color", next === "light" ? "rgb(255, 249, 233)" : "rgb(27, 41, 34)");
  });

  test(`meeting permission notification follows ${theme} theme`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("echoScribe.themePref", value), theme);
    await installTauriMock(page);
    await page.setViewportSize({ width: 520, height: 96 });
    await page.goto("/src/consent-overlay/index.html");
    await expect.poll(async () => {
      await page.evaluate(() => (window as any).__MOCK_EMIT__("show-consent", { bundle_id: "us.zoom", app_name: "Zoom" }));
      return page.locator(".consent-overlay.visible").count();
    }).toBe(1);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("html")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.getByRole("alertdialog")).toHaveCSS("background-color", theme === "light" ? "rgb(255, 249, 233)" : "rgb(27, 41, 34)");
    await expect(page.getByRole("button")).toHaveCount(3);
    await expect(page.getByRole("alertdialog")).toHaveCSS("opacity", "1");
    if (process.env.BUBBLE_SHOTS) await page.screenshot({ path: `${process.env.BUBBLE_SHOTS}/consent-${theme}.png` });
  });
}

test("standalone overlay follows system theme in auto mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => localStorage.setItem("echoScribe.themePref", "auto"));
  await installTauriMock(page);
  await page.goto("/src/overlay/index.html");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

for (const card of [
  { route: "action-toast", selector: ".action-toast", event: "show-action-toast", payload: { kind: "stay_awake", message: "Keeping your Mac awake" } },
  { route: "agent-toast", selector: ".agent-toast", event: "agent-toast:report", payload: { request: "Add a task", status: "running", answer: "", changes: [], sources: [] } },
  { route: "meeting-toast", selector: ".meeting-toast", event: "show-meeting-toast", payload: { app_name: "Zoom" } },
  { route: "activity-bubble", selector: ".activity-bubble", event: "show-activity-bubble", payload: { mode: "recording" } },
]) {
  test(`${card.route} uses shared corners and reserves pointer for pet placement`, async ({ page }) => {
    await installTauriMock(page);
    await page.setViewportSize({ width: 422, height: 200 });
    await page.goto(`/src/${card.route}/index.html`);
    await expect.poll(async () => {
      await page.evaluate(({ event, payload }) => (window as any).__MOCK_EMIT__(event, payload), card);
      return page.locator(card.selector).count();
    }).toBe(1);
    const surface = page.locator(card.selector);
    await expect(surface).toHaveCSS("border-radius", "17px");
    expect(await surface.evaluate((el) => getComputedStyle(el, "::after").display)).toBe("none");
    // Native placement explicitly opts into the pet pointer.
    await page.evaluate(() => (window as any).__MOCK_EMIT__("bubble-tail", { label: "main", side: "bottom", x: 180 }));
    await expect(surface).toHaveCSS("border-bottom-right-radius", "5px");
    expect(await surface.evaluate((el) => getComputedStyle(el, "::after").width)).toBe("14px");
    await page.evaluate(() => (window as any).__MOCK_EMIT__("bubble-tail", { label: "main", side: "none", x: 0 }));
    await expect(surface).toHaveCSS("border-radius", "17px");
    expect(await surface.evaluate((el) => getComputedStyle(el, "::after").display)).toBe("none");
  });
}
