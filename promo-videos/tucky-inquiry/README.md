# Tucky — "The inquiry" promo film

- `tucky-inquiry-110s.mp4` — master (1920×1080, 30 fps, H.264 CRF 16, AAC 320k, -14 LUFS). Upload this to YouTube.
- `tucky-inquiry-110s-1080p-web.mp4` — lighter 1080p encode for sharing.
- `STORY-CARD.md` — the story as agreed (five questions, going deeper each chapter).
- `storyboard-contact-sheet.png`, `poster-frame.png`, `thumbnail-talk.png`, `thumbnail-free.png` (YouTube thumbnails, rendered from the `ThumbTalk`/`ThumbFree` stills).
- `YOUTUBE.md` — title, description, chapters, tags, settings.
- `stems/` — narration lines (loudness-normalized WAV) and the music bed.
- `remotion-project/` — full source. Same pipeline as the LiveCase films.

## Re-render

```bash
cd remotion-project
npm install            # TypeScript must stay on 5.x
npm run studio         # live editor
npm run render         # writes out/tucky-promo.mp4
ffmpeg -i out/tucky-promo.mp4 -c:v copy -af "loudnorm=I=-14:TP=-1.5:LRA=11" -c:a aac -b:a 320k ../tucky-inquiry-110s.mp4
```

- Timing: `src/timeline.ts` (chapter boundaries `T`, cue points `CUE`, narration starts `VO`, SFX schedule).
- Scenes: `src/scenes.tsx` (Ch1–Ch5, Close). UI pieces: `src/ui.tsx`. Palette: `src/theme.ts` (landing-page colors).
- Narration: `ENV_FILE=/path/to/.env node tools/vo-tucky.cjs public/vo [ids]` — uses the voice saved in the Hume account as "Tucky Narrator …" (`public/vo/voice.json`). Normalize each line to -16 LUFS afterwards.
- Music: `node tools/music-warm.cjs public/music/bed.wav '{"turn":15,"lift":92,"hit":102.4,"end":110}'`
- SFX: `node tools/sfx-synth.cjs public/sfx`
