/**
 * Visual QA harness for the meeting HUD — the HUD is its own Tauri window, so
 * it can't be opened in a browser without a stand-in for the IPC layer. Serves
 * a fixed transcript so the talk widgets and the Caught tab have real data to
 * render. Sibling of visual-qa.ts, which does the same for the main window.
 */
type Segment = {
  speaker: "you" | "them";
  start_ms: number;
  end_ms: number;
  text: string;
};

const TRANSCRIPT: Segment[] = [
  { speaker: "you", start_ms: 0, end_ms: 42000, text: "So the way I see it, all the incentive structures that exist are there to force you to learn. The professor is there to say this is the Bible, and you spend three years figuring out what it means." },
  { speaker: "them", start_ms: 43000, end_ms: 58000, text: "Right, but Louis had two months to learn the book and he never finished it." },
  { speaker: "you", start_ms: 59000, end_ms: 154000, text: "That's the point though. The maturity comes after. If you come in at 8am every day for 2 weeks you get the diploma, you get the job, and that's a forcing function. We had 40 customers doing exactly that and it worked." },
  { speaker: "them", start_ms: 156000, end_ms: 171000, text: "Can we move the deadline to Friday? I think we need the extra time." },
  { speaker: "you", start_ms: 172000, end_ms: 188000, text: "How much would that actually buy us?" },
  { speaker: "them", start_ms: 189000, end_ms: 240000, text: "Maybe 20% more coverage. It cost us $1,200 last time we rushed it, so it pays for itself." },
];

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  get_live_transcript: () => TRANSCRIPT,
  get_active_guides: () => [],
  list_guide_templates: () => [
    { id: "g1", name: "Clear communication", description: "Keep statements short and concrete" },
    { id: "g2", name: "Discovery", description: "Surface the real problem" },
  ],
  list_summary_templates: () => [{ id: "s1", name: "Default" }],
  get_active_meeting_workspace: () => null,
  "plugin:event|listen": () => Math.floor(Math.random() * 100000),
  "plugin:event|unlisten": () => undefined,
};

/* The event plugin unregisters listeners through its own internals object, not
   through __TAURI_INTERNALS__ — without this, every effect cleanup throws. */
(window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ =
  {
    unregisterListener() {
      return undefined;
    },
  };

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  metadata: {
    currentWindow: { label: "meeting-hud" },
    currentWebview: { label: "meeting-hud" },
    currentWebviewWindow: { label: "meeting-hud" },
  },
  transformCallback(callback: (value: unknown) => void) {
    const id = Math.floor(Math.random() * 1_000_000_000);
    (window as unknown as Record<string, unknown>)[`_${id}`] = callback;
    return id;
  },
  unregisterListener() {
    return undefined;
  },
  invoke(command: string, args: Record<string, unknown> = {}) {
    const handler = handlers[command];
    if (handler) return Promise.resolve(handler(args));
    if (/^(list_|search_)/.test(command)) return Promise.resolve([]);
    if (/^(get_|is_)/.test(command)) return Promise.resolve(null);
    return Promise.resolve(undefined);
  },
};

await import("../src/meeting-hud/main");
