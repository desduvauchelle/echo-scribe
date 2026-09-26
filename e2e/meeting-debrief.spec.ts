import { expect, test, type Page } from "@playwright/test";
import { installTauriMock, recordedCalls, type Scenario } from "./mock";

const SHOTS = process.env.DEBRIEF_SHOTS_DIR;

const people: NonNullable<Scenario["people"]> = [
  { id: "person-sarah", name: "Sarah Connor", email: null, role: null, company_id: null, notes: "", created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-01T10:00:00Z" },
  { id: "person-john", name: "John Smith", email: null, role: null, company_id: null, notes: "", created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-01T10:00:00Z" },
];

const participant = (key: string, name: string, personId: string | null) => ({
  meeting_id: "meeting-debrief-1",
  speaker_key: key,
  person_id: personId,
  display_name: name,
  source: "auto",
  confirmed: false,
  created_at: "2026-09-25T09:00:00Z",
  updated_at: "2026-09-25T09:00:00Z",
});

const scenario: Scenario = {
  onboardingCompleted: true,
  permissions: { microphone: true, accessibility: true },
  speechModelReady: true,
  llmReady: true,
  projectCount: 2,
  people,
  debriefs: [
    {
      meetingId: "meeting-debrief-1",
      title: "Launch planning sync",
      startedAt: "2026-09-25T09:00:00Z",
      durationMs: 32 * 60_000,
      projectId: "project-1",
      participants: [
        participant("you", "Me", null),
        participant("them", "Speaker 1", null),
        participant("manual:person-sarah", "Sarah Connor", "person-sarah"),
      ],
      suggestions: [
        { id: "sugg-1", text: "Send the launch checklist to design", ownerName: "sarah", status: "pending" },
        { id: "sugg-2", text: "Book the retro room", ownerName: "me", status: "pending" },
      ],
    },
  ],
};

async function openDashboard(page: Page, sc: Scenario = scenario) {
  await installTauriMock(page, sc);
  await page.goto("/");
  const card = page.getByRole("article", { name: "Launch planning sync" });
  await expect(card).toBeVisible();
  return card;
}

test("debrief card: accept an edited task, skip one, then Done", async ({ page }) => {
  const card = await openDashboard(page);

  // Project pre-filled from the auto-assignment; people chips shown (the
  // user's own mic channel is not listed); unnamed speaker offered a link.
  await expect(card.getByLabel("Project")).toHaveValue("project-1");
  await expect(card.getByRole("button", { name: "Remove Sarah Connor" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Remove Speaker 1" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Remove Me" })).toHaveCount(0);
  await expect(card.getByLabel("Who is Speaker 1?")).toBeVisible();

  const rows = card.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Add task" }) });
  await expect(rows).toHaveCount(2);

  // Assignee pre-filled from ownerName: "sarah" → Sarah Connor, "me" → Me.
  const first = rows.nth(0);
  await expect(first.getByLabel("Assignee")).toHaveValue("person-sarah");
  await expect(rows.nth(1).getByLabel("Assignee")).toHaveValue("");

  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/debrief-${await currentTheme(page)}.png`, fullPage: false });
  }

  // Edit + reassign, then accept.
  await first.getByLabel("Task").fill("Send the final launch checklist to design");
  await first.getByLabel("Assignee").selectOption("person-john");
  await first.getByRole("button", { name: "Add task" }).click();
  await expect(card.getByRole("status").filter({ hasText: "Added" })).toBeVisible();

  const accepted = (await recordedCalls(page)).filter((c) => c.cmd === "accept_meeting_task_suggestion");
  expect(accepted).toHaveLength(1);
  expect(accepted[0].args).toEqual({
    suggestionId: "sugg-1",
    text: "Send the final launch checklist to design",
    assigneePersonId: "person-john",
    projectId: "project-1",
    deadline: null,
  });

  // Skip the other one: it disappears immediately.
  await rows.filter({ has: page.getByRole("textbox", { name: "Task" }) }).first()
    .getByRole("button", { name: "Skip" }).click();
  const dismissed = (await recordedCalls(page)).filter((c) => c.cmd === "dismiss_meeting_task_suggestion");
  expect(dismissed.map((c) => c.args)).toEqual([{ suggestionId: "sugg-2" }]);
  await expect(card.getByText("All follow-ups handled")).toBeVisible();

  // Nothing was ever created without a click.
  expect(
    (await recordedCalls(page)).filter((c) => c.cmd === "accept_meeting_task_suggestion"),
  ).toHaveLength(1);

  await card.getByRole("button", { name: "Done" }).click();
  await expect(card).toHaveCount(0);
  const completed = (await recordedCalls(page)).filter((c) => c.cmd === "complete_meeting_debrief");
  expect(completed.map((c) => c.args)).toEqual([{ meetingId: "meeting-debrief-1", status: "done" }]);
  await expect(page.getByText("Meeting debrief", { exact: true })).toHaveCount(0);
});

test("debrief card: no suggestions shows a one-liner and people can still be added", async ({ page }) => {
  const card = await openDashboard(page, {
    ...scenario,
    debriefs: [{ ...scenario.debriefs![0], suggestions: [] }],
  });
  await expect(card.getByText("No follow-ups spotted")).toBeVisible();

  await card.getByRole("button", { name: "Add person" }).click();
  await card.getByLabel("Search or add a name…").fill("Priya");
  await card.getByRole("button", { name: "Add “Priya” as a new person" }).click();

  await expect(card.getByRole("button", { name: "Remove Priya" })).toBeVisible();
  const calls = await recordedCalls(page);
  expect(calls.some((c) => c.cmd === "save_person" && c.args.name === "Priya")).toBe(true);
  expect(calls.some((c) => c.cmd === "add_meeting_participant" && c.args.meetingId === "meeting-debrief-1")).toBe(true);
});

test("debrief section: dismiss-all closes every pending debrief", async ({ page }) => {
  const second = { ...scenario.debriefs![0], meetingId: "meeting-debrief-2", title: "Hiring sync" };
  await openDashboard(page, { ...scenario, debriefs: [...scenario.debriefs!, second] });
  await expect(page.getByRole("article", { name: "Hiring sync" })).toBeVisible();

  await page.getByRole("button", { name: "Dismiss all debriefs" }).click();

  await expect(page.getByText("Meeting debrief", { exact: true })).toHaveCount(0);
  const completed = (await recordedCalls(page)).filter((c) => c.cmd === "complete_meeting_debrief");
  expect(completed.map((c) => c.args).sort((a, b) => String(a.meetingId).localeCompare(String(b.meetingId)))).toEqual([
    { meetingId: "meeting-debrief-1", status: "dismissed" },
    { meetingId: "meeting-debrief-2", status: "dismissed" },
  ]);
});

test("dashboard shows no debrief section when none are pending", async ({ page }) => {
  await installTauriMock(page, { ...scenario, debriefs: [] });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Activity statistics" })).toBeVisible();
  await expect(page.getByText("Meeting debrief", { exact: true })).toHaveCount(0);
});

async function currentTheme(page: Page) {
  return page.evaluate(() => document.documentElement.dataset.theme ?? "dark");
}
