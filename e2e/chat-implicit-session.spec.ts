import { expect, test } from "@playwright/test";
import { installTauriMock } from "./mock";

// With no chat selected, typing + Send must start a new chat on its own —
// no "New Chat" click required.
test("sending with no chat selected creates a session and keeps the message", async ({ page }) => {
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    llmReady: true,
  });
  await page.goto("/");
  await expect(page.locator(".echo-app-shell")).toBeVisible();
  await page.evaluate(() => {
    const internals = (window as any).__TAURI_INTERNALS__;
    const originalInvoke = internals.invoke;
    const calls: { cmd: string; args: any }[] = [];
    (window as any).__CHAT_CALLS__ = calls;
    const session = {
      id: "chat-new", name: "New Chat", project_id: null,
      created_at: "2026-09-25T12:00:00Z", updated_at: "2026-09-25T12:00:00Z",
    };
    let created = false;
    internals.invoke = (cmd: string, args: any) => {
      if (cmd === "list_chat_sessions") return Promise.resolve(created ? [session] : []);
      if (cmd === "create_chat_session") {
        calls.push({ cmd, args });
        created = true;
        return Promise.resolve(session);
      }
      if (cmd === "load_chat_messages") return Promise.resolve([]);
      if (cmd === "chat_with_memory") {
        calls.push({ cmd, args });
        return Promise.resolve({ reply: "Here is your answer.", sources: [] });
      }
      return originalInvoke(cmd, args);
    };
  });
  await page.getByRole("button", { name: "Chat", exact: true }).click();

  const input = page.getByRole("textbox");
  await expect(input).toBeEnabled();
  await input.fill("What did I do today?");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  await send.click();

  const conversation = page.locator('[aria-live="polite"]');
  await expect(conversation.getByText("What did I do today?")).toBeVisible();
  await expect(conversation.getByText("Here is your answer.")).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__CHAT_CALLS__);
  expect(calls.map((c: any) => c.cmd)).toEqual(["create_chat_session", "chat_with_memory"]);
  expect(calls[1].args.sessionId).toBe("chat-new");
});
