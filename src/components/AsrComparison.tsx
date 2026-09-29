import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { decodeComparisonAudio, median, wordErrorRate } from "../lib/asrComparison";

type Model = { id: string; name: string; size_bytes: number; downloaded: boolean };
type Status = { worker_ready: boolean; models: Model[] };
type Result = { id: string; text: string; load_ms: number; first_ms: number; warm_ms: number[]; audio_seconds: number; loaded_rss_mib: number; peak_rss_mib: number; backend: string; total_ms: number };
const button = "cursor-pointer rounded-lg border border-line px-3 py-2 text-xs font-medium hover:bg-elevated disabled:cursor-default disabled:opacity-40";
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

export default function AsrComparison() {
  const [status, setStatus] = useState<Status | null>(null);
  const [selected, setSelected] = useState("whisper-turbo");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [saved, setSaved] = useState("");
  const [audio, setAudio] = useState<{ samples: Float32Array; name: string; url: string; recorded: boolean; extension: string } | null>(null);
  const [reference, setReference] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const locked = useRef(false);
  const audioUrl = useRef("");
  const refresh = () => invoke<Status>("asr_lab_status").then((s) => { if (alive.current) setStatus(s); });
  useEffect(() => {
    alive.current = true;
    void refresh().catch((e) => setError(String(e)));
    const unlisten = listen<{ bytes_downloaded: number; bytes_total: number; retrying: boolean }>("asr-lab-download", ({ payload: p }) => setProgress(p.retrying ? "Connection interrupted; retrying…" : `${Math.round(p.bytes_downloaded / p.bytes_total * 100)}% downloaded`));
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
      URL.revokeObjectURL(audioUrl.current);
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);
  async function useAudio(blob: Blob, name: string, recorded = false) {
    const samples = await decodeComparisonAudio(blob);
    if (!alive.current) return;
    URL.revokeObjectURL(audioUrl.current);
    audioUrl.current = URL.createObjectURL(blob);
    const extension = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : blob.type.includes("wav") ? "wav" : "webm";
    setAudio({ samples, name, url: audioUrl.current, recorded, extension });
    setResults([]);
  }
  async function perform(label: string, action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(label); setError("");
    try { await action(); } catch (e) { if (alive.current) setError(String(e)); }
    finally { locked.current = false; if (alive.current) { setBusy(""); setProgress(""); } }
  }
  async function startRecording() {
    await perform("Opening microphone…", async () => {
      const input = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current) { input.getTracks().forEach((t) => t.stop()); return; }
      stream.current = input;
      try {
        const capture = new MediaRecorder(input);
        recorder.current = capture;
        const chunks: Blob[] = [];
        capture.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        capture.onerror = () => { input.getTracks().forEach((t) => t.stop()); setRecording(false); setError("Microphone recording failed. Try importing an audio file."); };
        capture.onstop = () => {
          input.getTracks().forEach((t) => t.stop());
          if (timer.current) clearTimeout(timer.current);
          if (!alive.current) return;
          setRecording(false);
          void perform("Preparing recording…", () => useAudio(new Blob(chunks, { type: capture.mimeType }), "Microphone recording", true));
        };
        capture.start(); setRecording(true);
        // Leave enough headroom for the recorder's final encoded frame.
        timer.current = setTimeout(() => { if (capture.state === "recording") capture.stop(); }, 59000);
      } catch (e) { input.getTracks().forEach((t) => t.stop()); throw e; }
    });
  }
  const selectedModel = status?.models.find((m) => m.id === selected);
  async function run(ids: string[]) {
    if (!audio) return;
    await perform("Comparing models…", async () => {
      for (const id of ids) {
        if (!alive.current) break;
        setBusy(`Testing ${status?.models.find((m) => m.id === id)?.name ?? id} · load + 4 transcriptions…`);
        const result = await invoke<Result>("asr_lab_run", { id, samples: Array.from(audio.samples) });
        if (alive.current) setResults((old) => [...old.filter((r) => r.id !== id), result]);
      }
    });
  }
  const disabled = !!busy || recording;
  return <section aria-labelledby="asr-lab-title" className="rounded-xl border border-line bg-canvas p-5 text-fg">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="asr-lab-title" className="text-base font-semibold">Parakeet vs. Whisper</h2><span className="rounded-full bg-elevated px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted">Local development only</span></div>
    <p className="mt-2 text-sm text-muted">Which understands you better? Record once, then compare the exact same audio on your Mac.</p>
    <div className="mt-4 grid gap-3 sm:grid-cols-2 text-xs text-muted">
      <p><strong className="text-fg">Parakeet v3</strong><br />Your current engine. 25 European languages, automatic detection. ONNX, CPU, int8.</p>
      <p><strong className="text-fg">Whisper</strong><br />Broader language coverage. Start with Large v3 Turbo Q5 for quality, or Base for a smaller download. whisper.cpp, Metal on Mac.</p>
    </div>
    {status && !status.worker_ready && <div className="mt-4 rounded-lg border border-line bg-elevated p-3 text-xs">One-time setup: run <code>bun run asr:setup</code> in this checkout. <button className="ml-2 underline" onClick={() => void perform("Checking worker…", refresh)}>Check again</button></div>}
    <div className="mt-5 flex flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-col gap-1 text-xs font-medium">Model to test<select className="max-w-full rounded-lg border border-line bg-surface p-2 text-sm" value={selected} disabled={disabled} onChange={(e) => setSelected(e.target.value)}>{status?.models.map((m) => <option key={m.id} value={m.id}>{m.name} · {Math.round(m.size_bytes / 1e6)} MB{m.downloaded ? " · Ready" : ""}</option>)}</select></label>
      <button className={button} disabled={disabled || !selectedModel || selectedModel.downloaded} onClick={() => void perform("Downloading model…", async () => { await invoke("asr_lab_download", { id: selected }); await refresh(); })}>{selectedModel?.downloaded ? "Downloaded" : "Download model"}</button>
    </div>
    <div className="mt-5 border-t border-line pt-4">
      <h3 className="text-sm font-medium">1. Add a short recording</h3>
      <p className="mt-1 text-xs text-muted">Up to 60 seconds. Recording uses your system default microphone. Include names, numbers, an accent, or a little background noise to make the comparison useful.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={button} disabled={!!busy} onClick={() => recording ? recorder.current?.stop() : void startRecording()}>{recording ? "Stop recording" : "Record microphone"}</button>
        <label className={`${button} ${disabled ? "pointer-events-none opacity-40" : ""}`}>Import audio<input aria-label="Import comparison audio" type="file" accept="audio/*,.wav,.mp3,.m4a" className="sr-only" disabled={disabled} onChange={(e) => { const file = e.target.files?.[0]; if (file) void perform("Preparing audio…", () => useAudio(file, file.name)); e.target.value = ""; }} /></label>
      </div>
      {recording && <p role="status" className="mt-2 text-xs">Recording… stops automatically after 59 seconds.</p>}
      {audio && <div className="mt-3"><p className="mb-2 break-words text-xs text-muted">{audio.name} · {(audio.samples.length / 16000).toFixed(1)} seconds · same 16 kHz mono input for every model</p><audio controls src={audio.url} className="h-9 w-full" />{audio.recorded && <div className="mt-3"><a className={button} href={audio.url} download={`tucky-voice-sample.${audio.extension}`}>Download recording</a><p className="mt-3 text-xs text-muted">Save the recording, then attach the file in this chat so I can run the same clip through each model.</p></div>}</div>}
      <label className="mt-4 flex flex-col gap-2 text-xs font-medium">What was actually said? <span className="font-normal text-muted">Optional reference transcript for word error rate. Lower is better; ignores case and punctuation. Numbers and spelling still count.</span><textarea className="min-h-20 rounded-lg border border-line bg-surface p-3 text-sm font-normal" maxLength={12000} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Type or paste the exact words you spoke…" /></label>
    </div>
    <div className="mt-5 border-t border-line pt-4"><h3 className="text-sm font-medium">2. Compare speed and accuracy</h3>
      <div className="mt-3 flex flex-wrap gap-2"><button className={button} disabled={disabled || !audio || !status?.worker_ready || !selectedModel?.downloaded} onClick={() => void run([selected])}>Test selected model</button><button className={button} disabled={disabled || !audio || !status?.worker_ready || (status?.models.filter((m) => m.downloaded).length ?? 0) < 2} onClick={() => void run(status!.models.filter((m) => m.downloaded).map((m) => m.id))}>Compare downloaded models</button></div>
      <p className="mt-3 text-xs leading-relaxed text-muted">Each test starts a fresh worker, loads one model, transcribes once, then repeats three times. Warm time is the median of those repeats. Loading includes engine initialization; OS file caches may already be warm. Memory is worker RSS, not total app or GPU memory. Models unload after each test. This tests raw recognition; everyday dictation settings stay unchanged.</p>
    </div>
    <div aria-live="polite" className="mt-3 text-xs">{busy}{progress && ` ${progress}`}</div>
    {error && <p role="alert" className="mt-3 break-words text-sm text-danger">{error}</p>}
    {results.length > 0 && <div className="mt-5 space-y-4">
      <div className="overflow-x-auto"><table className="w-full text-left text-xs"><caption className="mb-3 text-left text-sm font-medium">Results for this recording</caption><thead className="text-muted"><tr>{["Model", "Load", "First pass", "Warm", "Speed¹", "WER²", "Loaded / peak RSS"].map((h) => <th key={h} className="whitespace-nowrap border-b border-line p-2 font-medium">{h}</th>)}</tr></thead><tbody>{results.map((r) => { const warm = median(r.warm_ms); const wer = wordErrorRate(reference, r.text); return <tr key={r.id}><th className="border-b border-line p-2 font-medium">{status?.models.find((m) => m.id === r.id)?.name}<span className="block whitespace-nowrap text-[10px] font-normal text-muted">{r.backend}</span></th>{[seconds(r.load_ms), seconds(r.first_ms), seconds(warm), `${(r.audio_seconds * 1000 / warm).toFixed(1)}×`, wer === null ? "Add reference" : `${(wer * 100).toFixed(1)}%`, `${Math.round(r.loaded_rss_mib)} / ${Math.round(r.peak_rss_mib)} MiB`].map((v, i) => <td key={i} className="whitespace-nowrap border-b border-line p-2 tabular-nums">{v}</td>)}</tr>; })}</tbody></table></div>
      <p className="text-[11px] text-muted">¹ Audio duration ÷ warm transcription time; higher is faster. ² Word error rate can exceed 100% when many extra words are inserted. These results describe this recording, not overall model quality.</p>
      {results.map((r) => <article key={r.id} className="rounded-lg border border-line p-3"><h4 className="text-xs font-semibold">{status?.models.find((m) => m.id === r.id)?.name}</h4><p className="mt-2 whitespace-pre-wrap break-words text-sm">{r.text || "(No speech recognized)"}</p><p className="mt-2 text-[10px] text-muted">Entire benchmark: {seconds(r.total_ms)} · warm runs: {r.warm_ms.map(seconds).join(", ")}</p></article>)}
      <button className={button} disabled={disabled} onClick={() => void perform("Saving results…", async () => {
        setSaved("");
        const path = await invoke<string | null>("asr_lab_export", { report: JSON.stringify({ audio: audio?.name, reference, results: results.map((r) => ({ ...r, word_error_rate: wordErrorRate(reference, r.text) })) }, null, 2) });
        if (path) setSaved(`Saved to ${path}`);
      })}>Export results</button>
      {saved && <p role="status" className="break-words text-xs text-muted">{saved}</p>}
    </div>}
    <p className="mt-4 text-[11px] text-muted">Audio stays on this computer. Model downloads use Hugging Face. <a className="underline" href="https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3" target="_blank" rel="noreferrer">Parakeet model card</a> · <a className="underline" href="https://github.com/openai/whisper" target="_blank" rel="noreferrer">Whisper documentation</a></p>
  </section>;
}
