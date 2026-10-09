import { chromium } from "playwright";
import { installTauriMock } from "../e2e/mock";
import { strict as assert } from "node:assert";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 780, height: 900 } });
await installTauriMock(page, { onboardingCompleted: true, permissions: { microphone: true, accessibility: true }, speechModelReady: true, llmReady: true });
await page.addInitScript(() => {
  const internals = (window as any).__TAURI_INTERNALS__;
  const original = internals.invoke;
  internals.metadata.currentWindow.label = "gmail_assistant";
  internals.metadata.currentWebview.label = "gmail_assistant";
  internals.metadata.currentWebviewWindow.label = "gmail_assistant";
  const draft = {
    id: "review-1", account_id: "account-1", from: "denis@example.com", revision: 1,
    fields: { to: "alex@example.com", cc: "", subject: "Website proposal", body: "Hello Alex,\nTuesday works for me.\nDenis" },
    reply_to: { id: "mail-1", thread_id: "thread-1", from: "Alex <alex@example.com>", to: "denis@example.com", cc: "", reply_to: "", subject: "Website proposal", date: "2 Oct 2026", snippet: "Can we meet Tuesday?", body: "Hi Denis,\nCan we meet Tuesday to discuss the website proposal?\nAlex", partial: false, message_id: "<parent@example.com>", references: "" },
    gmail_id: null, saved_revision: null, status: "review", sent_message_id: null,
  };
  (window as any).__EMAIL_CALLS__ = [];
  (window as any).__EMAIL_DRAFT__ = draft;
  internals.invoke = (cmd: string, args: any) => {
    (window as any).__EMAIL_CALLS__.push({ cmd, args });
    if (cmd === "gmail_assistant_state") return Promise.resolve({ report: null, draft: structuredClone(draft), busy: false });
    if (cmd === "gmail_update_draft") {
      if (args.revision !== draft.revision) return Promise.reject("Stale draft");
      draft.fields = structuredClone(args.fields); draft.revision++;
      return Promise.resolve(structuredClone(draft));
    }
    if (cmd === "gmail_save_draft") { draft.gmail_id = "gmail-draft-1"; draft.saved_revision = draft.revision; return Promise.resolve(structuredClone(draft)); }
    if (cmd === "gmail_send_draft") {
      if ((window as any).__EMAIL_FAIL_SEND__) { draft.status = "write_unknown"; return Promise.reject("Connection failed; Gmail may have accepted the send."); }
      draft.status = "sent"; draft.sent_message_id = "sent-1";
      return Promise.resolve(structuredClone(draft));
    }
    if (cmd === "gmail_run_assistant") {
      if (args.focus) { draft.fields = structuredClone(args.focus.fields); draft.fields.body = "Shorter reply based on current draft and original email."; draft.revision++; }
      return Promise.resolve({ request: args.request, status: "done", answer: "Draft ready for review.", sources: [], draft: structuredClone(draft) });
    }
    if (cmd === "gmail_open_draft" || cmd === "gmail_stop_assistant") return Promise.resolve();
    return original(cmd, args);
  };
});
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const getCalls = () => page.evaluate(() => (window as any).__EMAIL_CALLS__);
await page.goto(`${process.env.TUCKY_QA_URL ?? "http://127.0.0.1:4198"}/src/gmail-assistant/index.html`);
await page.getByRole("heading", { name: "Reply for review" }).waitFor();
assert.equal(await page.locator("#draft-subject").isDisabled(), true);
assert.match(await page.getByRole("region", { name: "Email draft" }).innerText(), /denis@example.com/);
assert.match(await page.getByRole("region", { name: "Email draft" }).innerText(), /Can we meet Tuesday/);
await page.getByRole("button", { name: "Send…", exact: true }).click();
assert.equal((await getCalls()).filter((c: any) => c.cmd === "gmail_send_draft").length, 0);
await page.locator("#draft-body").fill("Manually edited reply before saving");
assert.equal(await page.getByRole("button", { name: "Send email", exact: true }).count(), 0);
await page.getByRole("button", { name: "Save to Gmail", exact: true }).click();
await page.getByRole("status").filter({ hasText: "Draft saved to Gmail" }).waitFor();
const saved = await getCalls();
assert.equal(saved.filter((c: any) => c.cmd === "gmail_save_draft").length, 1);
assert.equal(saved.find((c: any) => c.cmd === "gmail_update_draft").args.fields.body, "Manually edited reply before saving");
await page.locator("#draft-body").fill("Latest unsaved version for contextual edit");
await page.locator("#email-request").fill("Make this shorter");
await page.getByRole("button", { name: "Ask Tucky", exact: true }).click();
await page.locator("#draft-body").filter({ hasText: "Shorter reply" }).waitFor();
const asked = (await getCalls()).find((c: any) => c.cmd === "gmail_run_assistant");
assert.equal(asked.args.focus.fields.body, "Latest unsaved version for contextual edit");
assert.equal(asked.args.focus.draft_id, "review-1");
await page.locator("#draft-body").focus();
await page.evaluate(() => (window as any).__MOCK_EMIT__("gmail:capture", "fixture-capture"));
await page.getByText("Listening…", { exact: true }).waitFor();
const capture = (await getCalls()).find((c: any) => c.cmd === "plugin:event|emit" && c.args.event === "gmail:captured:fixture-capture");
assert.equal(capture.args.payload.draft_id, "review-1");
assert.equal(capture.args.payload.fields.body, "Shorter reply based on current draft and original email.");
await page.evaluate(() => (window as any).__MOCK_EMIT__("voice:recording_stopped", null));
await page.setViewportSize({ width: 440, height: 800 });
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
await page.screenshot({ path: "/tmp/tucky-gmail-review.png", fullPage: true });
await page.getByRole("button", { name: "Send…", exact: true }).click();
await page.getByRole("button", { name: "Send email", exact: true }).click();
await page.getByRole("status").filter({ hasText: "Email sent" }).waitFor();
assert.equal((await getCalls()).filter((c: any) => c.cmd === "gmail_send_draft").length, 1);
assert.equal(await page.getByRole("button", { name: "Send…", exact: true }).count(), 0);
assert.deepEqual(errors, []);

await page.reload();
await page.getByRole("heading", { name: "Reply for review" }).waitFor();
await page.evaluate(() => { (window as any).__EMAIL_FAIL_SEND__ = true; });
await page.getByRole("button", { name: "Send…", exact: true }).click();
await page.getByRole("button", { name: "Send email", exact: true }).click();
await page.getByText("The previous save or send has an unresolved result.", { exact: false }).waitFor();
assert.equal((await getCalls()).filter((c: any) => c.cmd === "gmail_send_draft").length, 1);
assert.equal(await page.getByRole("button", { name: "Send…", exact: true }).count(), 0);
await browser.close();
console.log("PASS: reply context, subject preservation, local edits, Gmail save, current draft AI context, capture snapshot, responsive layout, explicit send, and ambiguous-send protection. No real Gmail requests.");
