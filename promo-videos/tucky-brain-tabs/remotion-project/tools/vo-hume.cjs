// Generate narration with Hume Octave TTS. Designs a voice from a description on first run and saves it
// to the Hume account so every later line (and every re-take) uses the same voice.
// usage: ENV_FILE=/path/to/.env node vo-hume.cjs <lines.json> <out-dir> [ids,comma,separated]
//   lines.json: [["01","First line."],["02","Second line."], ...]
//   out-dir/voice.json: {name,id,description} — created on first run; edit description BEFORE first run.
// Reads HUME_API_KEY from ENV_FILE inside Node only. Never prints keys.
const fs = require('fs'); const path = require('path');
const [linesPath, out, onlyArg] = process.argv.slice(2);
if (!linesPath || !out) { console.log('usage: ENV_FILE=.env node vo-hume.cjs lines.json out-dir [ids]'); process.exit(1); }
const env = {}; for (const line of fs.readFileSync(process.env.ENV_FILE, 'utf8').split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, ''); }
if (!env.HUME_API_KEY) { console.log('HUME_API_KEY missing in ENV_FILE'); process.exit(1); }
const LINES = JSON.parse(fs.readFileSync(linesPath, 'utf8')); const only = onlyArg ? onlyArg.split(',') : null;
fs.mkdirSync(out, { recursive: true }); const voicePath = path.join(out, 'voice.json');
const H = { 'X-Hume-Api-Key': env.HUME_API_KEY, 'Content-Type': 'application/json' };
const DEFAULT_DESC = "Warm, confident narrator in their late thirties. Conversational, unhurried, a smile in the voice. Natural pauses, crisp diction, no announcer energy, no hype.";
const tts = async (body) => { const r = await fetch('https://api.hume.ai/v0/tts', { method: 'POST', headers: H, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 300)); return j.generations[0]; };
(async () => {
  let voice = fs.existsSync(voicePath) ? JSON.parse(fs.readFileSync(voicePath, 'utf8')) : { description: DEFAULT_DESC };
  const DESC = voice.description || DEFAULT_DESC;
  if (!voice.id) {
    const g = await tts({ utterances: [{ text: LINES[0][1], description: DESC, speed: 1.0, trailing_silence: 0.1 }], format: { type: 'mp3' }, num_generations: 1 });
    fs.writeFileSync(path.join(out, `${LINES[0][0]}.mp3`), Buffer.from(g.audio, 'base64'));
    const name = (voice.prefix || 'Promo Narrator') + ' ' + Math.random().toString(36).slice(2, 8);
    const s = await fetch('https://api.hume.ai/v0/tts/voices', { method: 'POST', headers: H, body: JSON.stringify({ generation_id: g.generation_id, name }) });
    const sj = await s.json(); if (!s.ok) throw new Error('save: ' + JSON.stringify(sj).slice(0, 300));
    voice = { name, id: sj.id, description: DESC }; fs.writeFileSync(voicePath, JSON.stringify(voice, null, 1)); console.log('voice saved:', name, '| line', LINES[0][0], g.duration.toFixed(2) + 's');
  }
  let prevGen = null;
  for (const [id, text] of LINES) {
    const f = path.join(out, `${id}.mp3`);
    if (only ? !only.includes(id) : fs.existsSync(f)) continue; // without ids: only missing lines; with ids: force those
    const body = { utterances: [{ text, voice: { name: voice.name, provider: 'CUSTOM_VOICE' }, description: DESC, speed: 1.0, trailing_silence: 0.1 }], format: { type: 'mp3' }, num_generations: 1 };
    if (prevGen) body.context = { generation_id: prevGen }; // keeps delivery consistent line to line
    try { const g = await tts(body); prevGen = g.generation_id; fs.writeFileSync(f, Buffer.from(g.audio, 'base64')); console.log(id, g.duration.toFixed(2) + 's'); }
    catch (e) { console.log(id, 'err', e.message); }
  }
  console.log('done → run normalize-vo.sh', out);
})();
