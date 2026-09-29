import { loadFont as loadInterTight } from "@remotion/google-fonts/InterTight";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

const tight = loadInterTight("normal", { weights: ["600", "700", "800", "900"], subsets: ["latin"] });
const inter = loadInter("normal", { weights: ["400", "500", "600", "700", "800"], subsets: ["latin"] });
const mono = loadMono("normal", { weights: ["500", "700"], subsets: ["latin"] });

export const FONT_DISPLAY = `${tight.fontFamily}, "Inter Tight", Inter, "Helvetica Neue", Arial, sans-serif`;
export const FONT_BODY = `${inter.fontFamily}, Inter, "Helvetica Neue", Arial, sans-serif`;
export const FONT_MONO = `${mono.fontFamily}, "JetBrains Mono", Menlo, monospace`;
export const fontsReady = Promise.all([tight.waitUntilDone(), inter.waitUntilDone(), mono.waitUntilDone()]);
