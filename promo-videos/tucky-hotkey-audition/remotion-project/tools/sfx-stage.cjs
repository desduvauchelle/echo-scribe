// Stage SFX for "The Hotkey Audition": cricket (awkward silence) and applause. 48 kHz stereo WAV.
// usage: node tools/sfx-stage.cjs public/sfx
const fs = require('fs'); const SR = 48000; const out = process.argv[2];
function wav(path, L, R) {
  const n = L.length; const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4); buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4); }
  fs.writeFileSync(path, buf);
}
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 * 2 - 1; };
const norm = (x, p) => { let m = 0; for (const v of x) m = Math.max(m, Math.abs(v)); return x.map((v) => v * (m ? p / m : 1)); };
// CRICKET: 3 chirps, each 4 quick pulses of a 4.6 kHz tone, ~2.4 s
{ const d = 2.4, n = SR * d; const x = new Float32Array(n);
  for (const c of [0.05, 0.85, 1.65]) for (let k = 0; k < 4; k++) {
    const s = c + k * 0.045; for (let i = Math.floor(s * SR); i < Math.floor((s + 0.03) * SR) && i < n; i++) { const t = i / SR - s; x[i] += Math.sin(2 * Math.PI * 4600 * t) * Math.sin(Math.PI * t / 0.03) ** 2; }
  }
  const y = norm(x, 0.5); wav(`${out}/cricket.wav`, y, y.map((v, i) => (i > 40 ? y[i - 40] : 0))); }
// APPLAUSE: ~400 random claps (short filtered noise bursts) swelling then fading, ~3.2 s
{ const d = 3.2, n = SR * d; const L = new Float32Array(n), R = new Float32Array(n);
  for (let c = 0; c < 420; c++) {
    const s = Math.abs(rnd()) * (d - 0.2); const pan = (rnd() + 1) / 2; const len = Math.floor(SR * (0.008 + 0.01 * Math.abs(rnd())));
    const env = Math.min(1, s / 0.5) * Math.min(1, (d - s) / 1.4); let lpS = 0;
    for (let j = 0; j < len; j++) { const i = Math.floor(s * SR) + j; if (i >= n) break; lpS += 0.55 * (rnd() - lpS); const v = lpS * Math.exp(-j / (len / 3)) * env; L[i] += v * (1 - pan); R[i] += v * pan; }
  }
  wav(`${out}/applause.wav`, norm(L, 0.7), norm(R, 0.7)); }
console.log('stage sfx written');
