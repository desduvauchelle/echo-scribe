export function wordErrorRate(reference: string, hypothesis: string): number | null {
  // Case/punctuation insensitive. Preserve Unicode letters and numbers; apostrophes
  // are removed so typographic apostrophes and ASR punctuation do not create errors.
  const words = (s: string) => s.normalize("NFKC").toLocaleLowerCase().replace(/['’]/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];
  const expected = words(reference), actual = words(hypothesis);
  if (!expected.length) return null;
  let row = Array.from({ length: actual.length + 1 }, (_, i) => i);
  for (let i = 1; i <= expected.length; i++) {
    const next = [i];
    for (let j = 1; j <= actual.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (expected[i - 1] === actual[j - 1] ? 0 : 1));
    row = next;
  }
  return row[actual.length] / expected.length;
}
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
export async function decodeComparisonAudio(blob: Blob): Promise<Float32Array> {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    if (audio.duration < 0.1 || audio.duration > 60) throw new Error("Choose audio between 0.1 and 60 seconds.");
    const offline = new OfflineAudioContext(1, Math.ceil(audio.duration * 16000), 16000);
    const source = offline.createBufferSource();
    source.buffer = audio;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).map((v) => Math.max(-1, Math.min(1, v)));
  } finally { await context.close(); }
}
