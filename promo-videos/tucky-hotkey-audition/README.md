# Tucky — "The Hotkey Audition" promo film (82 s)

A talent-show parody: three apps audition for your last good hotkey. Superwhisper and Wispr Flow do voice-to-text flawlessly, then bow into cricket silence. Tucky does the same, then keeps going: commands, tasks filed by project, meetings, ask, focus, recap and screen recording. The story is in `STORY-CARD.md`.

Competitor fairness rule: every line about Superwhisper and Wispr Flow stays within "types what you say, well". Their tiles are generic drawings, with no copied logos. The narration spells it "Whisper Flow" so the TTS pronounces it correctly; on screen it reads "Wispr Flow".

Files (media is gitignored): `tucky-hotkey-audition-82s.mp4` (master, -14 LUFS), `…-1080p-web.mp4`, `storyboard-contact-sheet.png`, `poster-frame.png`.

## Re-render
```bash
cd remotion-project && npm install
bash ~/.claude/skills/promo-film/scripts/master.sh ./remotion-project Film tucky-hotkey-audition-82s 64.2   # from this folder
```
- Timing: `src/timeline.ts` (VO starts, T acts, CUE, SFX; the music ducks under the cricket silences).
- Stage kit: `src/stage.tsx` (stage/curtains/spotlight, contestant tiles, name cards, judges + scorecards, key + pedestal, marquee, cricket).
- Scenes: `src/scenes.tsx` (Open, Act1 Superwhisper, Act2 Wispr Flow, Act3 Tucky, Close). Shared UI: `src/brain.tsx`, `src/ui.tsx`.
- Extra SFX: `node tools/sfx-stage.cjs public/sfx` (cricket, applause) on top of `tools/sfx-synth.cjs`.
- Music: `node tools/music-warm.cjs public/music/bed.wav '{"turn":37.9,"lift":58.5,"hit":74.6,"end":81.5}'`.
