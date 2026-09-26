// Refresh the standalone, idle animated artwork: bun scripts/export-tucky-svg.tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TuckyArtwork } from "../src/desktop-pet/TuckyArtwork";

const css = await Bun.file(new URL("../src/desktop-pet/pet.css", import.meta.url)).text();
const artwork = renderToStaticMarkup(createElement("svg", null, createElement(TuckyArtwork)))
  .replace(/^<svg>/, "").replace(/<\/svg>$/, "");
const clips = [470, 788].map(cx => `<clipPath id="eye-${cx}"><ellipse cx="${cx}" cy="509" rx="69" ry="94"/></clipPath>`).join("");
await Bun.write(new URL("../public/mascot/tucky-animated.svg", import.meta.url),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="180 100 900 1080" role="img" aria-label="Tucky"><style>${css}\n@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}</style><defs>${clips}</defs><g class="pet-body reaction-idle">${artwork}</g></svg>`);
