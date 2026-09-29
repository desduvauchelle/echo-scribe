import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import common from "../src/locales/en/common.json";
import SpeechModelPicker, { SpeechModelRow } from "../src/components/SpeechModelPicker";
import type { SpeechModelStatus } from "../src/lib/api";
import { benchmarkGrade } from "../src/lib/asrModelBenchmarks";

await i18n.use(initReactI18next).init({ lng: "en", resources: { en: { translation: common } }, initImmediate: false });
const model: SpeechModelStatus = {
  id: "whisper-base", display_name: "Whisper", version_label: "Base", description: "",
  language_label: "Multilingual", supported_languages: ["en"], english_only: false,
  accuracy_bars: 0, speed_bars: 0, size_label: "Small", size_bytes: 147951465,
  downloaded: true, active: false, supported: true, disk_bytes: 147951465, incomplete: false,
};
function row(overrides: Partial<SpeechModelStatus> = {}, active = false, progress = false) {
  return renderToStaticMarkup(<table><tbody><SpeechModelRow model={{ ...model, ...overrides }} active={active} downloading={progress ? { bytes_downloaded: 50, bytes_total: 100 } : null} downloadError={null} busy={false} onDownload={() => {}} onActivate={() => {}} onDelete={() => {}} /></tbody></table>);
}
test("settings starts with a compact popup trigger and no inline model table", () => {
  const html = renderToStaticMarkup(<SpeechModelPicker />);
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('<table');
});
test("downloaded rows expose selection and removal; active rows do not offer re-selection", () => {
  expect(row()).toContain('Use this model');
  expect(row()).toContain('Remove Whisper Base');
  expect(row({}, true)).toContain('Active');
  expect(row({}, true)).not.toContain('Use this model');
});
test("undownloaded and downloading rows expose the appropriate action", () => {
  const missing = row({ downloaded: false });
  expect(missing).toContain('Download');
  expect(missing).not.toContain('Use this model');
  const downloading = row({ downloaded: false }, false, true);
  expect(downloading).toContain('<progress');
  expect(downloading).toContain('50% downloaded');
  expect(downloading).not.toContain('Use this model');
});
test("rows use table semantics and show comparable measured values", () => {
  const previous = process.env.VITE_LOCAL_ASR;
  process.env.VITE_LOCAL_ASR = "1";
  const html = row();
  if (previous === undefined) delete process.env.VITE_LOCAL_ASR;
  else process.env.VITE_LOCAL_ASR = previous;
  expect(html).toContain('scope="row"');
  expect(html).toContain('20.8% word errors');
  expect(html).toContain('0.19 s transcription');
  expect(html).toContain('0.38 GiB peak');
  expect(benchmarkGrade('errors', 8)).toBe(4);
  expect(benchmarkGrade('memoryGiB', 0.38)).toBe(5);
});
