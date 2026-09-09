import { useEffect, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { Copy, FolderOpen, Loader, Plus, Sparkles, Trash2 } from "lucide-react";
import { readRecordingEvents, revealRecordingFile, type RecordingRow } from "../lib/api";
import { parseProject } from "../lib/editorProject";
import { createRecordingFeedback, exportShot, frameReader, loadRecordingFeedback, saveRecordingFeedback, savedBundleForReview,
  type FeedbackBundle, type FeedbackFinding, type FeedbackShot } from "../lib/recordingFeedback";

type Session = { bundle: FeedbackBundle | null; status: string; error: string; loaded: boolean; dirty: boolean };
const sessions = new Map<string, Session>();
const subscribers = new Set<() => void>();
function session(id: string): Session {
  if (!sessions.has(id)) sessions.set(id, { bundle: null, status: "", error: "", loaded: false, dirty: false });
  return sessions.get(id)!;
}
function update(id: string, patch: Partial<Session>) {
  sessions.set(id, { ...session(id), ...patch });
  subscribers.forEach(fn => fn());
}
function subscribe(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; }
async function run(id: string, status: string, work: () => Promise<void>) {
  update(id, { status, error: "" });
  try { await work(); } catch (e) {
    console.error("[recording-feedback]", e);
    update(id, { error: e instanceof Error ? e.message : String(e) });
  } finally { update(id, { status: "" }); }
}

async function save(rec: RecordingRow): Promise<FeedbackBundle> {
  const id = rec.id;
  const bundle = session(id).bundle;
  if (!bundle) throw new Error("Create a prompt first.");
  const items = [];
  for (const item of bundle.findings) {
    const screenshots = [];
    for (const shot of item.screenshots) screenshots.push(await exportShot(shot, parseProject(rec.project_json).masks));
    items.push({ ...item, screenshots });
  }
  const saved = await saveRecordingFeedback(id, { ...bundle, findings: items });
  // Retain unmarked originals in memory so markers remain freely editable.
  update(id, { bundle: { ...bundle, directory: saved.directory, markdown: saved.markdown }, dirty: false });
  return saved;
}

const field = "w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-fg";
const button = "inline-flex items-center justify-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-fg hover:bg-surface disabled:opacity-50";

export default function RecordingFeedback({ rec }: { rec: RecordingRow }) {
  const id = rec.id;
  const state = useSyncExternalStore(subscribe, () => session(id));
  const [copied, setCopied] = useState(false);
  const busy = !!state.status;

  useEffect(() => {
    if (session(id).loaded) return;
    update(id, { loaded: true });
    void run(id, "Loading saved prompt…", async () => {
      const saved = await loadRecordingFeedback(id);
      if (saved) update(id, { bundle: savedBundleForReview(saved) });
    });
  }, [id]);

  const edit = (index: number, patch: Partial<FeedbackFinding>) => {
    const bundle = session(id).bundle!;
    update(id, { dirty: true, bundle: { ...bundle, findings: bundle.findings.map((item, i) => i === index ? { ...item, finding: { ...item.finding, ...patch } } : item) } });
    setCopied(false);
  };
  const editShot = (index: number, shotIndex: number, shot: FeedbackShot) => {
    const bundle = session(id).bundle!;
    update(id, { dirty: true, bundle: { ...bundle, findings: bundle.findings.map((item, i) => i === index ? { ...item,
      screenshots: item.screenshots.map((s, j) => j === shotIndex ? shot : s) } : item) } });
  };

  const generate = () => void run(id, "Transcribing your walkthrough…", async () => {
    const stop = await listen<{ id: string; stage: string }>("recording-feedback-progress", event => {
      if (event.payload.id === id) update(id, { status: "Organizing your feedback…" });
    });
    let result;
    try { result = await createRecordingFeedback(id); } finally { stop(); }
    const events = await readRecordingEvents(id).catch(() => "");
    const reader = await frameReader(rec, events);
    try {
      const findings = [];
      for (const [i, finding] of result.findings.entries()) {
        update(id, { status: `Capturing screenshots ${i + 1} of ${result.findings.length}…` });
        const first = await reader.capture(finding.startMs);
        const last = await reader.capture(finding.endMs);
        findings.push({ finding, screenshots: last.timeMs - first.timeMs > 500 ? [first, last] : [first] });
      }
      update(id, { bundle: { findings, transcript: result.transcript, directory: "", markdown: "" }, dirty: true });
    } finally { reader.dispose(); }
    update(id, { status: "Saving prompt and images…" });
    await save(rec);
  });

  const recapture = (index: number, shotIndex: number, seconds: number) => void run(id, "Updating screenshot…", async () => {
    const reader = await frameReader(rec, await readRecordingEvents(id).catch(() => ""));
    try {
      if (seconds * 1000 > reader.durationMs) throw new Error("Choose a time within the recording.");
      editShot(index, shotIndex, await reader.capture(seconds * 1000));
    } finally { reader.dispose(); }
  });

  return <section className="mt-5 border-t border-line pt-4" aria-label="Fix prompt">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-medium">Turn this walkthrough into a fix prompt</h3>
      {!state.bundle && <button className={button} disabled={busy} onClick={generate}><Sparkles size={14} /> Create fix prompt</button>}
    </div>
    <p className="mt-2 text-xs leading-relaxed text-muted">Describe what to fix, change, or keep. Get a list with screenshots to give your coding AI. For page URLs, include the browser address bar in your recording.</p>
    {busy && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-muted"><Loader size={14} className="animate-spin" />{state.status}</p>}
    {state.error && <p role="alert" className="mt-3 text-xs text-danger">{state.error}</p>}
    {state.bundle && <>
      <p className="mt-3 text-xs leading-relaxed text-muted">Review the targets and wording. The local AI organizes your narration; it does not inspect the images. Screenshots retain the full frame and cover existing privacy masks.</p>
      <fieldset disabled={busy} className="mt-3 min-w-0 space-y-4 disabled:opacity-60">
        {state.bundle.findings.length === 0 && <p className="text-xs text-muted">No findings were identified. Review the narration below, or add a finding.</p>}
        {state.bundle.findings.map((item, index) => <article key={index} className="space-y-2 rounded-lg border border-line p-3" aria-label={`Finding ${index + 1}`}>
          <div className="flex items-center gap-2">
            <span className="text-xs text-faint">{index + 1}.</span>
            <input aria-label={`Finding ${index + 1} title`} className={`${field} min-w-0 flex-1`} value={item.finding.title} onChange={e => edit(index, { title: e.target.value })} />
            <button className="shrink-0 p-1 text-faint hover:text-danger" aria-label={`Remove finding ${index + 1}`} onClick={() => {
              const bundle = session(id).bundle!;
              update(id, { dirty: true, bundle: { ...bundle, findings: bundle.findings.filter((_, i) => i !== index) } });
            }}><Trash2 size={14} /></button>
          </div>
          <select aria-label={`Finding ${index + 1} type`} className={field} value={item.finding.kind} onChange={e => edit(index, { kind: e.target.value as FeedbackFinding["kind"] })}>
            <option value="fix">Fix a problem</option><option value="change">Make a change</option><option value="preserve">Keep this</option><option value="question">Needs clarification</option>
          </select>
          <label className="block text-xs text-muted">Page or URL (optional)<input className={`${field} mt-1`} placeholder="Otherwise, refer to the address bar in the images" value={item.finding.location} onChange={e => edit(index, { location: e.target.value })} /></label>
          <blockquote className="border-l-2 border-line pl-2 text-xs leading-relaxed text-muted">{item.finding.quote}</blockquote>
          <label className="block text-xs text-muted">Requested result<textarea rows={3} className={`${field} mt-1 resize-y`} value={item.finding.request} onChange={e => edit(index, { request: e.target.value })} /></label>
          <label className="block text-xs text-muted">Needs checking<textarea rows={2} className={`${field} mt-1 resize-y`} value={item.finding.uncertainty} onChange={e => edit(index, { uncertainty: e.target.value })} /></label>
          {item.screenshots.map((shot, shotIndex) => <ShotEditor key={`${shotIndex}-${shot.timeMs}`} shot={shot} disabled={busy} label={`Finding ${index + 1}, screenshot ${shotIndex + 1}`}
            onCapture={seconds => recapture(index, shotIndex, seconds)} onChange={next => editShot(index, shotIndex, next)} />)}
        </article>)}
        <button className={button} onClick={() => void run(id, "Adding a finding…", async () => {
          const reader = await frameReader(rec, "");
          try {
            const shot = await reader.capture(0, null);
            const bundle = session(id).bundle!;
            update(id, { dirty: true, bundle: { ...bundle, findings: [...bundle.findings, { finding: { title: "New finding", kind: "question", quote: "Added during review.", request: "Describe the requested change.", uncertainty: "Confirm the target and screenshot timing.", location: "", startMs: 0, endMs: 0 }, screenshots: [shot] }] } });
          } finally { reader.dispose(); }
        })}><Plus size={14} /> Add finding</button>
      </fieldset>
      <div className="mt-4 flex flex-wrap gap-2">
        <button disabled={busy} className={button} onClick={() => void run(id, "Saving prompt…", async () => {
          const saved = await save(rec);
          await navigator.clipboard.writeText(saved.markdown);
          setCopied(true);
        })}><Copy size={14} /> {copied && !state.dirty ? "Prompt copied" : "Save & copy prompt"}</button>
        <button disabled={busy} className={button} onClick={() => void run(id, "Opening prompt and images…", async () => {
          const saved = state.dirty ? await save(rec) : session(id).bundle!;
          await revealRecordingFile(`${saved.directory}/prompt.md`);
        })}><FolderOpen size={14} /> Open prompt & images</button>
      </div>
      <p className="mt-2 text-xs text-muted">Paste the prompt, then attach the JPG files from its folder. Copying text does not attach images.{state.dirty ? " You have unsaved changes." : " Saved locally with this recording."}</p>
      <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Full narration</summary>
        <div className="mt-2 max-h-48 space-y-2 overflow-y-auto">{state.bundle.transcript.map((s, i) => <p key={i}><span className="text-faint">{(s.startMs / 1000).toFixed(1)}s </span>{s.text}</p>)}</div>
      </details>
    </>}
  </section>;
}

function ShotEditor({ shot, label, disabled, onCapture, onChange }: {
  shot: FeedbackShot; label: string; disabled: boolean; onCapture: (seconds: number) => void; onChange: (shot: FeedbackShot) => void;
}) {
  const [seconds, setSeconds] = useState(String(shot.timeMs / 1000));
  const editable = shot.image.startsWith("data:");
  return <div className="space-y-2 pt-2">
    <div className="relative">
      <img src={shot.image} alt={`${label} at ${(shot.timeMs / 1000).toFixed(2)} seconds`} className={`block w-full rounded border border-line ${editable ? "cursor-crosshair" : ""}`} onClick={e => {
        if (disabled || !editable) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onChange({ ...shot, marker: [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height] });
      }} />
      {shot.marker && <span aria-hidden="true" className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-rose-500 ring-1 ring-white" style={{ left: `${shot.marker[0] * 100}%`, top: `${shot.marker[1] * 100}%` }} />}
    </div>
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs text-muted">Time (seconds)<input aria-label={`${label} time`} type="number" min="0" step="0.1" value={seconds} onChange={e => setSeconds(e.target.value)} className={`${field} mt-1 block w-24`} /></label>
      <button className={button} onClick={() => onCapture(Number(seconds))} disabled={!seconds || !Number.isFinite(Number(seconds)) || Number(seconds) < 0}>Capture this moment</button>
      {shot.marker && <button className={button} onClick={() => onChange({ ...shot, marker: null })}>Clear marker</button>}
    </div>
    <details className="text-xs text-muted"><summary className="cursor-pointer">{editable ? "Click the image to mark the target, or enter its position" : "Recapture to change the saved marker"}</summary>
      {editable && <div className="mt-2 flex gap-2">{([0, 1] as const).map(axis => <label key={axis}>{axis === 0 ? "Horizontal %" : "Vertical %"}<input aria-label={`${label} ${axis === 0 ? "horizontal" : "vertical"} marker percent`} type="number" min="0" max="100" className={`${field} mt-1 w-24`} value={Math.round((shot.marker?.[axis] ?? 0.5) * 100)} onChange={e => {
        const marker: [number, number] = [...(shot.marker ?? [0.5, 0.5])];
        marker[axis] = Math.min(1, Math.max(0, Number(e.target.value) / 100));
        onChange({ ...shot, marker });
      }} /></label>)}</div>}
    </details>
  </div>;
}
