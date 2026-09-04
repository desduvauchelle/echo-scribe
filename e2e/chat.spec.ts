import { expect, test } from "@playwright/test";
import { installTauriMock } from "./mock";

const reply = `Based on the notes, the speech patterns include:

* **Problem-Solving and Technical Discussion:** A focus on technical aspects.
* **Visionary/Strategic Thinking:** Discussions about the future.

## Next steps

1. Review the *patterns*.
2. Read the [notes](https://example.com/notes).

| Pattern | Signal |
| --- | --- |
| Collaboration | Supportive |

~~~text
${"long-code-token-".repeat(40)}
~~~

${"longword".repeat(50)}`;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1094, height: 600 });
  await installTauriMock(page, {
    onboardingCompleted: true,
    permissions: { microphone: true, accessibility: true },
    speechModelReady: true,
    llmReady: true,
  });
  await page.goto("/");
  await expect(page.locator(".echo-app-shell")).toBeVisible();
  // Exercise the real Chat view with local IPC fixtures, without using the
  // installed app's database or invoking a model.
  await page.evaluate((content) => {
    const internals = (window as any).__TAURI_INTERNALS__;
    const originalInvoke = internals.invoke;
    const session = {
      id: "chat-markdown", name: "Speech patterns", project_id: null,
      created_at: "2026-09-03T12:00:00Z", updated_at: "2026-09-03T12:00:00Z",
    };
    internals.invoke = (cmd: string, args: unknown) => {
      if (cmd === "list_chat_sessions") return Promise.resolve([session]);
      if (cmd === "load_chat_messages") return Promise.resolve([
        { id: "user-1", session_id: session.id, role: "user", content: "Find **patterns** in my notes.\nKeep the details.", created_at: session.created_at },
        { id: "ai-1", session_id: session.id, role: "assistant", content, created_at: session.created_at },
      ]);
      if (cmd === "chat_with_memory") return new Promise((resolve) => {
        (window as any).__FINISH_CHAT__ = () => resolve({
          reply: "### New response\n\n* **Action:** Review the notes.",
          sources: [{ source_id: "note-1", date: "2026-09-03", kind: "note", content: "Source detail preserved." }],
        });
      });
      return originalInvoke(cmd, args);
    };
  }, reply);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "Speech patterns", exact: true }).click();
});

test("saved AI replies render Markdown without a bubble and fit narrow windows", async ({ page }) => {
  const conversation = page.locator('[aria-live="polite"]').filter({ hasText: "Based on the notes" });
  await expect(conversation.locator("li strong").first()).toHaveText("Problem-Solving and Technical Discussion:");
  await expect(conversation.getByRole("heading", { name: "Next steps" })).toBeVisible();
  await expect(conversation.locator("ol li")).toHaveCount(2);
  await expect(conversation.locator("em")).toHaveText("patterns");
  await expect(conversation.getByRole("link", { name: "notes", exact: true })).toHaveAttribute("href", "https://example.com/notes");
  await expect(conversation.getByRole("table")).toContainText("Collaboration");
  await expect(conversation.locator("pre code")).toContainText("long-code-token-");

  const assistant = conversation.getByText("Echo Scribe AI", { exact: true }).locator("..");
  await expect(assistant).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(assistant).toHaveCSS("border-radius", "0px");
  const user = conversation.getByText("Find **patterns** in my notes.", { exact: false });
  await expect(user).toHaveCSS("white-space", "pre-wrap");
  await expect(user.locator("..")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(user.locator("..")).not.toHaveCSS("border-radius", "0px");

  for (const width of [1094, 800]) {
    await page.setViewportSize({ width, height: 600 });
    expect(await conversation.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 1094, height: 600 });
  await conversation.evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: "output/playwright/chat-markdown.png" });
});

test("new replies and the thinking state have no bubble, and sources still expand", async ({ page }) => {
  const input = page.getByRole("textbox");
  await input.fill("What should I do next?");
  await input.press("Enter");
  const thinking = page.getByText("Thinking…", { exact: true });
  await expect(thinking).toBeVisible();
  await expect(thinking.locator("..")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(input).toBeDisabled();
  await page.evaluate(() => (window as any).__FINISH_CHAT__());
  await expect(page.getByRole("heading", { name: "New response" })).toBeVisible();
  await expect(page.locator("li strong").filter({ hasText: /^Action:$/ })).toBeVisible();
  const assistant = page.getByRole("heading", { name: "New response" }).locator("../..");
  await expect(assistant).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.getByRole("button", { name: /1 source/ }).click();
  await expect(page.getByText("Source detail preserved.")).toBeVisible();
  await expect(input).toBeEnabled();
});
