# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Visual direction

- The current prototype direction is minimalist wireframe: flat neutral surfaces, thin structural borders, compact spacing, and almost no decorative depth. Use it to validate hierarchy and navigation before introducing a final visual language.
- Do not reintroduce the earlier neumorphic/material treatment, large cast shadows, ornamental orbs, glow effects, or decorative gradients unless the user explicitly chooses that direction again.
- Keep the palette predominantly off-white and charcoal/off-black.
- Use solid canvas and panel colors. Depth should come from spacing and subtle surface contrast, not shadows, gradients, or container outlines.
- Avoid borders in general. Keep only the structural divider between the primary navigation and projects, plus the separators between dashboard statistics while that option is being evaluated.
- Use Echo Scribe's application accent tokens—`#2dd4bf` in dark mode and `#0f766e` in light mode—as a clearly visible theme color. Apply them to selected navigation, primary actions, activity icons, update status, and metric/status highlights without turning them into decorative borders.
- Hover states may change the surface or border color but must never translate or scale elements. Physical movement is reserved for the pressed state.
- The prototype sidebar should mirror Echo Scribe's real information architecture: Dashboard, Chat, Daily recaps, People & companies, the user's project list, update status, Settings, and theme control.
- Keep sidebar navigation compact: approximately 32 px primary rows, 29 px project rows, 1 px list gaps, 6 px radii, and no pill styling.
- Preserve the light/dark toggle and interactive navigation, capture, notification, and update-dismiss states.
- The dashboard activity sample should reflect Echo Scribe's real mixed feed: transcriptions, notes, tasks, meetings, and recordings. Keep interactive filter badges for All and each of those five types.
- Use `/Users/denisduvauchelle/Desktop/Screenshot 2026-07-29 at 2.05.42 PM.png` as the information-architecture reference, not as a visual-style reference.
