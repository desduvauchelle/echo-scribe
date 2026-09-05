import { test, expect } from "@playwright/test";
import { installTauriMock } from "./mock";

test("dictation reaches Tucky's controlled input after overlay focus loss", async ({ page }) => {
  await installTauriMock(page, { onboardingCompleted: true, speechModelReady: true,
    permissions: { microphone: true, accessibility: true } });
  await page.goto("/");
  await page.evaluate(() => {
    const api = (window as any).__TAURI_INTERNALS__;
    const original = api.invoke;
    api.invoke = (cmd: string, args: unknown) => cmd === "create_chat_session"
      ? Promise.resolve({ id: "practice", name: "Practice", project_id: null }) : original(cmd, args);
  });
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "New Chat", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("Hello world");
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 11));
  await page.evaluate(() => {
    (window as any).__MOCK_EMIT__("voice:self_capture", "regression");
    (document.activeElement as HTMLElement)?.blur();
    (window as any).__MOCK_EMIT__("voice:self_insert", {
      id: "regression", text: "Echo", expires_at: Date.now() + 2000, press_enter: false,
    });
  });
  await expect(input).toHaveValue("Hello Echo");
  await input.press("End");
  await input.press("!");
  await expect(input).toHaveValue("Hello Echo!");
  await page.evaluate(() => {
    (window as any).__MOCK_EMIT__("voice:self_insert", { id: "regression", text: "duplicate", expires_at: Date.now() + 2000, press_enter: false });
  });
  await expect(input).toHaveValue("Hello Echo!");
  await page.evaluate(() => (window as any).__MOCK_EMIT__("voice:self_capture", "changed"));
  await input.fill("A newer draft");
  await page.evaluate(() => {
    (window as any).__MOCK_EMIT__("voice:self_insert", { id: "changed", text: "stale dictation", expires_at: Date.now() + 2000, press_enter: false });
  });
  await expect(input).toHaveValue("A newer draft");
});
