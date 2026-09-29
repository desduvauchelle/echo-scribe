// Designs a new Hume Octave narrator for Tucky (line 01), saves it, then generates every line with it. Keys from ENV_FILE, never printed.
const fs = require('fs'); const path = require('path');
const envText = fs.readFileSync(process.env.ENV_FILE, 'utf8'); const env = {};
for (const line of envText.split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, ''); }
const out = process.argv[2]; const only = process.argv[3] ? process.argv[3].split(',') : null;
const voicePath = path.join(out, 'voice.json');
const LINES = [
  ["01", "It starts small. A prompt you can't quite type."],
  ["02", "So you press a key, and say it out loud."],
  ["03", "And it's... just there. Cleaner than you said it."],
  ["04", "Weird, at first."],
  ["05", "Day one, it feels strange. Talking to your laptop. Day two, you forget. Day three, you catch yourself pressing the key before you've decided to."],
  ["06", "By the end of the week, you talk to everything. Email. Code comments. That message you've been putting off."],
  ["07", "You even start giving it instructions. Tucky, make this an email. And it does. In your voice."],
  ["08", "That's the moment you can't go back."],
  ["09", "Then one evening, you open the library. Every thought you spoke this week is sitting there. Searchable. And you wonder... if my thoughts are worth keeping..."],
  ["10", "what about my conversations?"],
  ["11", "So the next call, you let it listen. Live transcript. A guide that tracks what you've covered, and nudges the next question."],
  ["12", "And when you hang up, the decisions and follow-ups are already written."],
  ["13", "Weeks go by. Meetings, notes, a screen recording you narrated for a client. It all lands in one place, sorted by project."],
  ["14", "So you ask it. What did we decide on pricing with Acme? And it answers. And shows you where it came from."],
  ["15", "Every morning: what happened, what matters, what's next."],
  ["16", "One last question. Where does all of this live? Here. On your Mac. No account. No cloud. No subscription."],
  ["17", "Free."],
  ["18", "It started with one key. Typing is overrated. Just talk."],
];
fs.writeFileSync(path.join(out, 'lines.json'), JSON.stringify(LINES, null, 1));
const H = { 'X-Hume-Api-Key': env.HUME_API_KEY, 'Content-Type': 'application/json' };
const DESC = "Warm, curious, slightly wry narrator in his late thirties. Intimate and conversational, like thinking out loud next to you. Unhurried, light, a smile in the voice. Natural pauses, no announcer energy, no hype. Crisp diction, mid-low pitch.";
(async () => {
  let voice = fs.existsSync(voicePath) ? JSON.parse(fs.readFileSync(voicePath, 'utf8')) : null;
  if (!voice) {
    const body = { utterances: [{ text: LINES[0][1], description: DESC, speed: 1.0, trailing_silence: 0.1 }], format: { type: 'mp3' }, num_generations: 1 };
    const r = await fetch('https://api.hume.ai/v0/tts', { method: 'POST', headers: H, body: JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) { console.log('design err', JSON.stringify(j).slice(0, 300)); process.exit(1); }
    const g = j.generations[0]; fs.writeFileSync(path.join(out, 'hume-01.mp3'), Buffer.from(g.audio, 'base64'));
    const name = 'Tucky Narrator ' + Math.random().toString(36).slice(2, 8);
    const s = await fetch('https://api.hume.ai/v0/tts/voices', { method: 'POST', headers: H, body: JSON.stringify({ generation_id: g.generation_id, name }) });
    const sj = await s.json(); if (!s.ok) { console.log('save err', JSON.stringify(sj).slice(0, 300)); process.exit(1); }
    voice = { name, id: sj.id }; fs.writeFileSync(voicePath, JSON.stringify(voice, null, 1)); console.log('voice saved', name, '01', g.duration.toFixed(2));
  }
  let prevGen = null;
  for (const [id, text] of LINES) {
    if (id === '01' && fs.existsSync(path.join(out, 'hume-01.mp3')) && !only) continue;
    if (only && !only.includes(id)) continue;
    const body = { utterances: [{ text, voice: { name: voice.name, provider: 'CUSTOM_VOICE' }, description: DESC, speed: 1.0, trailing_silence: 0.1 }], format: { type: 'mp3' }, num_generations: 1 };
    if (prevGen) body.context = { generation_id: prevGen };
    const r = await fetch('https://api.hume.ai/v0/tts', { method: 'POST', headers: H, body: JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) { console.log(id, 'err', JSON.stringify(j).slice(0, 300)); continue; }
    const g = j.generations[0]; prevGen = g.generation_id; fs.writeFileSync(path.join(out, `hume-${id}.mp3`), Buffer.from(g.audio, 'base64')); console.log('hume', id, g.duration.toFixed(2));
  }
  console.log('done');
})();
