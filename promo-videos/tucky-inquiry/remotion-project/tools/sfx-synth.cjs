// Procedural cinematic SFX one-shots -> 48kHz stereo WAV
const fs = require('fs');
const SR = 48000;
function wav(path, L, R) {
  const n = L.length; const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4); buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4); }
  fs.writeFileSync(path, buf);
}
let seed = 1; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 * 2 - 1; };
// simple one-pole lowpass
function lp(x, cutoffFn) { const y = new Float32Array(x.length); let s = 0; for (let i = 0; i < x.length; i++) { const c = cutoffFn(i / SR); const a = 1 - Math.exp(-2 * Math.PI * c / SR); s += a * (x[i] - s); y[i] = s; } return y; }
function norm(x, peak = 0.9) { let m = 0; for (const v of x) m = Math.max(m, Math.abs(v)); const g = m > 0 ? peak / m : 1; return x.map(v => v * g); }
function stereo(x, width = 0.0) { const L = new Float32Array(x.length), R = new Float32Array(x.length); for (let i = 0; i < x.length; i++) { const w = width * Math.sin(i / SR * 0.7); L[i] = x[i] * (1 - w * 0.2); R[i] = x[i] * (1 + w * 0.2); } return [L, R]; }
const out = process.argv[2];
// 1. BOOM: sub sine drop + noise thump, long tail
{ const d = 2.6, n = SR * d; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; const f = 42 + 80 * Math.exp(-t * 9); const env = Math.exp(-t * 2.2); const sub = Math.sin(2 * Math.PI * f * t) * env; const thump = rnd() * Math.exp(-t * 28) * 0.7; const rumble = rnd() * Math.exp(-t * 1.4) * 0.12; x[i] = sub * 0.9 + thump + rumble; }
  const y = lp(x, t => 220 + 900 * Math.exp(-t * 12)); const [L, R] = stereo(norm(y, 0.95)); wav(`${out}/boom.wav`, L, R); }
// 2. WHOOSH: filtered noise sweep up then down, 0.7s
{ const d = 0.8, n = SR * d; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; const env = Math.sin(Math.PI * Math.min(1, t / d)) ** 1.6; x[i] = rnd() * env; }
  const y = lp(x, t => 300 + 4200 * Math.sin(Math.PI * t / d)); const [L, R] = stereo(norm(y, 0.6), 1); wav(`${out}/whoosh.wav`, L, R); }
// 3. RISER: 3s noise + rising tone, exponential build
{ const d = 3.0, n = SR * d; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; const p = t / d; const env = Math.pow(p, 2.2); const f = 80 * Math.pow(2, p * 4); x[i] = rnd() * env * 0.7 + Math.sin(2 * Math.PI * f * t + Math.sin(t * 30) * 0.4) * env * 0.35; }
  const y = lp(x, t => 200 + 6000 * Math.pow(t / d, 2)); const [L, R] = stereo(norm(y, 0.8), 1); wav(`${out}/riser.wav`, L, R); }
// 4. TICK: short click for typing / UI
{ const d = 0.06, n = SR * d; const x = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / SR; x[i] = (rnd() * 0.5 + Math.sin(2 * Math.PI * 2400 * t)) * Math.exp(-t * 140); } const [L, R] = stereo(norm(x, 0.35)); wav(`${out}/tick.wav`, L, R); }
// 5. POP: soft UI pop (bubble appear)
{ const d = 0.22, n = SR * d; const x = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / SR; const f = 520 + 380 * Math.exp(-t * 40); x[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 26); } const [L, R] = stereo(norm(x, 0.5)); wav(`${out}/pop.wav`, L, R); }
// 6. CHIME: success ding (two partials)
{ const d = 1.4, n = SR * d; const x = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / SR; x[i] = Math.sin(2 * Math.PI * 1318.5 * t) * Math.exp(-t * 4) * 0.6 + Math.sin(2 * Math.PI * 1975.5 * t) * Math.exp(-t * 5) * 0.35 + Math.sin(2 * Math.PI * 659 * t) * Math.exp(-t * 3) * 0.3; } const [L, R] = stereo(norm(x, 0.5)); wav(`${out}/chime.wav`, L, R); }
// 7. IMPACT HIT: short bright transient + sub, for logo slam
{ const d = 1.8, n = SR * d; const x = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / SR; const sub = Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-t * 14)) * t) * Math.exp(-t * 3); const crack = rnd() * Math.exp(-t * 60); const metal = Math.sin(2 * Math.PI * 880 * t) * Math.exp(-t * 9) * 0.25; x[i] = sub * 0.9 + crack * 0.8 + metal; } const y = lp(x, t => 400 + 5000 * Math.exp(-t * 10)); const [L, R] = stereo(norm(y, 0.95)); wav(`${out}/hit.wav`, L, R); }
// 8. HEARTBEAT-ish pulse (single thump) for tension
{ const d = 0.5, n = SR * d; const x = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / SR; x[i] = Math.sin(2 * Math.PI * (60 + 30 * Math.exp(-t * 30)) * t) * Math.exp(-t * 12); } const [L, R] = stereo(norm(x, 0.8)); wav(`${out}/thump.wav`, L, R); }
console.log('sfx written');
