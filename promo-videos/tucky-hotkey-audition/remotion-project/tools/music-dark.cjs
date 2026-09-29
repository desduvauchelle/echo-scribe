// Procedural cinematic bed, DARK variant: drone → tension → bloom (D minor → D major). 48k stereo WAV.
// usage: node music-dark.cjs out.wav '{"turn":15,"lift":33,"hit":40,"end":45.5}'  (seconds; turn=drums in, lift=energy up, hit=final chord, end=length)
const fs = require('fs');
const SR = 48000; const T = JSON.parse(process.argv[3] || '{}');
const TURN = T.turn ?? 15.0, LIFT = T.lift ?? 33.0, HIT = T.hit ?? 40.0, END = T.end ?? 45.5, DUR = END + 0.5;
const N = Math.floor(SR * DUR); const L = new Float32Array(N), R = new Float32Array(N);
const BPM = 112, BEAT = 60 / BPM, BAR = BEAT * 4;
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 * 2 - 1; };
const TAU = Math.PI * 2;
const hz = (n) => 440 * Math.pow(2, (n - 69) / 12); // midi -> hz
// chord progression after TURN (midi): Dm, Bb, F, C ; final D major at HIT
const PROG = [[50, 53, 57, 62], [46, 53, 58, 62], [45, 53, 57, 60], [48, 52, 55, 60]];
const FINAL = [50, 54, 57, 62, 66];
const chordAt = (t) => { if (t >= HIT) return FINAL; const i = Math.floor((t - TURN) / (BAR * 2)) % PROG.length; return PROG[(i + PROG.length) % PROG.length]; };
// --- buses
const pad = new Float32Array(N), arp = new Float32Array(N), drums = new Float32Array(N), sub = new Float32Array(N), fx = new Float32Array(N), drone = new Float32Array(N);
// helpers
const smooth = (t, a, b) => Math.max(0, Math.min(1, (t - a) / (b - a)));
const ease = (x) => x * x * (3 - 2 * x);
function onePole(buf, cutoffFn) { let s = 0; for (let i = 0; i < buf.length; i++) { const c = cutoffFn(i / SR); const a = 1 - Math.exp(-TAU * c / SR); s += a * (buf[i] - s); buf[i] = s; } }
// 1) DRONE (0 -> TURN+2): D1 + D2 detuned sines + breathing
for (let i = 0; i < N; i++) { const t = i / SR; if (t > TURN + 3) break; const g = 0.42 * (1 - ease(smooth(t, TURN, TURN + 2.5))) * ease(smooth(t, 0, 2.5)) * (0.8 + 0.2 * Math.sin(t * 0.9));
  drone[i] = g * (Math.sin(TAU * 36.71 * t) * 0.9 + Math.sin(TAU * 73.42 * t) * 0.5 + Math.sin(TAU * 73.7 * t) * 0.3 + Math.sin(TAU * 110.0 * t) * 0.12 * (0.5 + 0.5 * Math.sin(t * 0.37))); }
// dark texture: filtered noise swell, growing tension until TURN
{ const nz = new Float32Array(N); for (let i = 0; i < N; i++) { const t = i / SR; if (t > TURN) break; nz[i] = rnd() * 0.08 * Math.pow(smooth(t, 2, TURN), 1.8); }
  onePole(nz, (t) => 120 + 2200 * Math.pow(smooth(t, 4, TURN), 2.2)); for (let i = 0; i < N; i++) fx[i] += nz[i]; }
// 2) TENSION PULSE: 8th-note low saw stabs from 6s to TURN, opening filter
{ const st = new Float32Array(N); for (let i = 0; i < N; i++) { const t = i / SR; if (t < 6 || t > TURN) continue; const ph = ((t - 6) % (BEAT / 2)) / (BEAT / 2); const env = Math.exp(-ph * 6) * (1 - ph) ; const f = hz(38); const saw = 2 * ((t * f) % 1) - 1; st[i] = saw * env * (0.08 + 0.22 * Math.pow(smooth(t, 6, TURN), 1.5)); }
  onePole(st, (t) => 180 + 1400 * Math.pow(smooth(t, 6, TURN), 2)); for (let i = 0; i < N; i++) fx[i] += st[i]; }
// 3) RISER into TURN and into HIT
function riser(t0, t1, amp) { const buf = new Float32Array(N); for (let i = Math.floor(t0 * SR); i < Math.min(N, Math.floor(t1 * SR)); i++) { const t = i / SR; const p = Math.max(0, Math.min(1, (t - t0) / (t1 - t0))); const f = 60 * Math.pow(2, p * 5); buf[i] = (rnd() * 0.7 + Math.sin(TAU * f * t) * 0.4) * Math.pow(p, 2.4) * amp; } onePole(buf, (t) => 200 + 7000 * Math.pow(smooth(t, t0, t1), 2)); for (let i = 0; i < N; i++) fx[i] += buf[i]; }
riser(TURN - 3.2, TURN, 0.22); riser(HIT - 2.2, HIT, 0.15);
// 4) PAD: detuned saws per chord note, slow attack, LP ~ 700-1400Hz, from TURN
{ const notes = new Map(); // key -> {start,end}
  for (let i = 0; i < N; i++) { const t = i / SR; if (t < TURN - 0.05) continue; const ch = chordAt(t); const gainLift = t >= LIFT ? 1.25 : 1;
    let s = 0; for (const n of ch) { const f = hz(n); const d = 0.004; s += (2 * ((t * f) % 1) - 1) * 0.5 + (2 * ((t * f * (1 + d)) % 1) - 1) * 0.35 + (2 * ((t * f * (1 - d)) % 1) - 1) * 0.35; if (t >= LIFT) s += (2 * ((t * f * 2.0 * (1 + d / 2)) % 1) - 1) * 0.18; }
    const env = ease(smooth(t, TURN - 0.05, TURN + 1.2)) * (t >= HIT ? 1.0 : 1) ; const tail = 1 - ease(smooth(t, END - 1.5, END + 0.4));
    pad[i] = s * 0.05 * env * gainLift * tail; }
  onePole(pad, (t) => 500 + 900 * (0.5 + 0.5 * Math.sin(t * 0.35)) + (t >= LIFT ? 500 : 0)); onePole(pad, (t) => 2400); }
// 5) ARP: 16th-note plucks over chord tones, from TURN, richer after LIFT
{ for (let i = 0; i < N; i++) { const t = i / SR; if (t < TURN || t > END - 1.5) continue; const step = BEAT / 4; const k = Math.floor((t - TURN) / step); const ph = (t - TURN - k * step); const ch = chordAt(t); const pattern = [0, 1, 2, 3, 2, 1]; const n = ch[pattern[k % pattern.length] % ch.length] + (t >= LIFT && k % 8 >= 4 ? 12 : 0) + 12; const f = hz(n);
    const env = Math.exp(-ph * 14); const tone = Math.sin(TAU * f * ph) * 0.6 + Math.sin(TAU * f * 2 * ph) * 0.25 + (2 * ((ph * f) % 1) - 1) * 0.15; const vel = (k % 4 === 0 ? 1 : 0.7) * (t >= LIFT ? 1.15 : 1) * (t >= HIT ? 0.6 : 1);
    arp[i] = tone * env * 0.16 * vel * ease(smooth(t, TURN, TURN + 0.8)); } onePole(arp, (t) => 2600 + (t >= LIFT ? 1500 : 0)); }
// 6) DRUMS: kick on beats + soft hats offbeat, from TURN to HIT; sub bass on roots with ducking
{ for (let i = 0; i < N; i++) { const t = i / SR; if (t < TURN || t > HIT + 0.05) continue; const tb = (t - TURN) % BEAT; const kick = Math.sin(TAU * (48 + 70 * Math.exp(-tb * 18)) * tb) * Math.exp(-tb * 7) * 0.75 + rnd() * Math.exp(-tb * 90) * 0.25;
    const th = (t - TURN + BEAT / 2) % BEAT; const hat = rnd() * Math.exp(-th * 60) * 0.05 * (t >= LIFT ? 1.4 : 1);
    const t8 = (t - TURN) % (BEAT / 2); const shaker = rnd() * Math.exp(-t8 * 45) * 0.025;
    drums[i] = kick + hat + shaker;
    const root = chordAt(t)[0] - 12; const duck = 1 - 0.6 * Math.exp(-tb * 9); sub[i] = Math.sin(TAU * hz(root) * t) * 0.32 * duck * ease(smooth(t, TURN, TURN + 0.3)); } }
// final sustain sub after HIT (D major) fading
for (let i = Math.floor(HIT * SR); i < N; i++) { const t = i / SR; sub[i] = Math.sin(TAU * hz(38) * t) * 0.3 * (1 - ease(smooth(t, END - 1.8, END + 0.3))); }
// 7) Reverb (Schroeder) on pad+arp+fx
function reverb(inp, mix, fb = 0.84) { const combs = [1694, 1760, 1622, 1547].map(d => ({ d, buf: new Float32Array(d), i: 0 })); const aps = [225, 556].map(d => ({ d, buf: new Float32Array(d), i: 0 })); const outL = new Float32Array(N), outR = new Float32Array(N);
  for (let n = 0; n < N; n++) { let acc = 0; for (const c of combs) { const y = c.buf[c.i]; c.buf[c.i] = inp[n] + y * fb; c.i = (c.i + 1) % c.d; acc += y; } acc *= 0.25; for (const a of aps) { const y = a.buf[a.i]; const v = acc + y * 0.5; a.buf[a.i] = v; a.i = (a.i + 1) % a.d; acc = y - 0.5 * v; } outL[n] = inp[n] * (1 - mix) + acc * mix; outR[n] = outL[n]; }
  // widen: slight delay on R
  for (let n = N - 1; n >= 0; n--) { const k = n - 480; outR[n] = 0.5 * outL[n] + 0.5 * (k >= 0 ? outL[k] : 0); } return [outL, outR]; }
const nanCount=(a)=>{let c=0,first=-1;for(let i=0;i<a.length;i++){if(Number.isNaN(a[i])){c++;if(first<0)first=i;}}return c+(first>=0?' first@'+(first/SR).toFixed(2)+'s':'');};
for (const [nm,b] of Object.entries({pad,arp,drums,sub,fx,drone})) console.log('NaN', nm, nanCount(b), 'max', b.reduce((m,v)=>Math.max(m,Math.abs(v)||0),0).toFixed(3));
const wet = new Float32Array(N); for (let i = 0; i < N; i++) wet[i] = pad[i] + arp[i] + fx[i] * 0.8; const [wL, wR] = reverb(wet, 0.32);
for (let i = 0; i < N; i++) { const dry = drone[i] + drums[i] + sub[i] + fx[i] * 0.2; L[i] = wL[i] + dry; R[i] = wR[i] + dry; }
// master: gentle LP, soft clip, normalize
onePole(L, () => 15000); onePole(R, () => 15000);
let peak = 0; for (let i = 0; i < N; i++) { L[i] = Math.tanh(L[i] * 1.4); R[i] = Math.tanh(R[i] * 1.4); peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
console.log('peak', peak, 'NaN L', nanCount(L));
const g = 0.95 / peak; const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(L[i] * g * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(R[i] * g * 32767), 46 + i * 4); }
fs.writeFileSync(process.argv[2], buf); console.log('music written', DUR.toFixed(1), 's; turn', TURN, 'lift', LIFT, 'hit', HIT);
