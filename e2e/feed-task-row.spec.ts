import { expect, test } from "@playwright/test";
import { installTauriMock } from "./mock";

const ready = {
  onboardingCompleted: true,
  permissions: { microphone: true, accessibility: true },
  speechModelReady: true,
  llmReady: true,
  projectCount: 2,
};

function item(id: string, content: string, kind: string, source: string, projectId: string | null, minutesAgo: number) {
  const iso = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    id,
    content,
    source,
    kind,
    project_id: projectId,
    captured_at: iso,
    created_at: iso,
    deleted_at: null,
    confidence: null,
    classified_by: null,
    capture_context: null,
    importance: null,
  };
}

const task = item("t1", "call the printer about proofs", "task", "log_capture", "project-1", 3);
const feedItems = [
  item("d1", "Remember to send the recap before Friday.", "transcription", "voice_at_cursor", null, 1),
  task,
  item("n1", "Pricing page needs a clearer annual toggle.", "note", "log_capture", "project-2", 30),
];

const calls = (page: import("@playwright/test").Page, cmd: string) =>
  page.evaluate(
    (c) => ((window as any).__MOCK_CALLS__ as { cmd: string; args: any }[]).filter((x) => x.cmd === c),
    cmd,
  );

test("All feed renders tasks with the Tasks-view row and ticking one completes it", async ({ page }) => {
  await installTauriMock(page, {
    ...ready,
    feedItems,
    tasks: [{ item: task, deadline: null, completed_at: null }],
    itemTags: { n1: ["pricing"] },
  });
  await page.goto("/");

  const row = page.locator(".echo-activity-ledger .activity-ledger-row", {
    hasText: "Call the printer about proofs",
  });
  await expect(row).toBeVisible();
  // Title is displayed capitalised; deadline pill sits on the row.
  await expect(row.getByRole("button", { name: "No deadline" })).toBeVisible();

  const checkbox = row.getByRole("checkbox", { name: "Complete task" });
  await expect(checkbox).toHaveAttribute("aria-checked", "false");
  await checkbox.click();

  await expect.poll(async () => (await calls(page, "complete_task")).map((c) => c.args.itemId)).toEqual(["t1"]);
  await expect(row.getByRole("checkbox", { name: "Mark task as not done" })).toHaveAttribute("aria-checked", "true");
  await expect(row.getByText(/^Done /)).toBeVisible();

  // Meta line: project chip first, relative time last (right-aligned).
  const meta = row.locator("div.mt-1\\.5").first();
  await expect(meta.locator("> span").first()).toHaveText("Project 1");
  await expect(meta.locator("> span").last()).toHaveClass(/ml-auto/);
});
