# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Visual direction

- Keep the palette predominantly off-white and charcoal/off-black.
- Create depth with a top-left light source: pale highlights on top/left edges and heavier shadows falling bottom-right.
- Avoid decorative multicolor gradients. Reserve cyan and violet for tiny active-state details and illumination around controls.
- Use a restrained monochrome environmental gradient on the canvas and sidebar: lightest at the upper-left, progressively darker toward the right and lower edge. Keep cards and controls solid so this reads as directional light, not decorative gradient styling.
- Do not use a cyan edge or border to mark selected navigation. Let the recessed/raised material state carry selection.
- Respect shadow occlusion between stacked surfaces: cards below another raised panel should not produce a bright white top halo.
- In dark mode, preserve visible material depth by keeping the canvas darker than raised surfaces and using restrained top-left edge light plus a stronger bottom-right cast shadow.
- Hover states may change shadow, border, or surface tone, but must never translate or scale elements. Physical movement is reserved for the pressed state.
- Reuse Echo Scribe's application accent tokens for the theme color: `#2dd4bf` in dark mode and `#0f766e` in light mode. Derive accent glows and tints from the active mode's token.
- The prototype sidebar should mirror Echo Scribe's real information architecture: Dashboard, Chat, Daily recaps, People & companies, the user's project list, update status, Settings, and theme control.
- Keep sidebar navigation compact and refined: approximately 34 px primary rows, 30 px project rows, 1-2 px list gaps, restrained radii, and quiet active-state shadows. Avoid oversized pills or generous vertical padding in dense navigation.
- Reference: `/Users/denisduvauchelle/Desktop/2c2b13e0d04fc7b9df06a1af2a99533a.jpg`.
