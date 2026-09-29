# Tucky — "Brain Tabs" promo film (95 s)

A satirical day inside a brain with 47 tabs open. Tucky takes the thoughts off your plate by voice, then keeps today's focus on screen. The story is in `STORY-CARD.md`. First cut decisions: "ADHD" is never said on screen, the project names are generic (Finance, Website relaunch, Personal, Ideas), the saved "Tucky Narrator" voice is directed deadpan, and the tagline is "Say it once. Forget it on purpose."

Files (all media is gitignored; only text and code are tracked):
- `tucky-brain-tabs-95s.mp4`: master (1080p30, -14 LUFS). Upload this one.
- `tucky-brain-tabs-95s-1080p-web.mp4`: lighter encode for sharing.
- `storyboard-contact-sheet.png`, `poster-frame.png`

## Re-render
```bash
cd remotion-project && npm install      # TypeScript must stay on 5.x
npm run studio                          # live editor
bash ~/.claude/skills/promo-film/scripts/master.sh ./remotion-project Film tucky-brain-tabs-95s 51.5   # from this folder
bash frames-at.sh remotion-project/out/raw.mp4 remotion-project/out/sheet 3 12 24 ...                 # frames at given seconds
```

- Timing: `src/timeline.ts`. It holds the narration starts `VO`, the chapters `T`, the cues `CUE`, the tab counter `TABS` and the `SFX` list.
- Scenes: `src/scenes.tsx` (Open, Ch1 loop + "your system", Ch2 hand it off, Ch3 focus + spoon, Close).
- Film-specific UI: `src/brain.tsx` (thought bubbles, tab counter, menu bar, pitch doc, capture cards, board columns, desktop-pet focus bubble, sticky note). Shared UI from the first film: `src/ui.tsx`.
- Narration: `public/vo/lines.json` + `voice.json` (the saved Hume voice "Tucky Narrator 7fht5v", with a deadpan direction). To re-take lines: `ENV_FILE=<path with HUME_API_KEY> node tools/vo-hume.cjs public/vo/lines.json public/vo 05,09`, then `bash ~/.claude/skills/promo-film/scripts/normalize-vo.sh public/vo`, and update the durations in `VO`.
- Music: `node tools/music-warm.cjs public/music/bed.wav '{"turn":31.9,"lift":59,"hit":86.9,"end":94.5}'`. SFX: `node tools/sfx-synth.cjs public/sfx`.
