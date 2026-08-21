import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseExports } from "../src/components/recordingActionButtons";

const editorSource = readFileSync(
  new URL("../src/views/sections/EditorView.tsx", import.meta.url),
  "utf8",
);

describe("recording export UX", () => {
  test("preserves the user-facing saved path alongside the managed export", () => {
    expect(
      parseExports(
        JSON.stringify([
          {
            quality: "rendered",
            path: "/managed/recording.rendered.mp4",
            size: 10,
            saved_path: "/Users/me/Downloads/Recording (edited).mp4",
            saved_size: 10,
          },
        ]),
      ),
    ).toEqual([
      {
        quality: "rendered",
        path: "/managed/recording.rendered.mp4",
        size: 10,
        saved_path: "/Users/me/Downloads/Recording (edited).mp4",
        saved_size: 10,
      },
    ]);
  });

  test("chooses a destination before rendering and offers the exact export in Finder", () => {
    const dialogCall = editorSource.indexOf("await chooseExportDestination(exportQuality)");
    const renderStart = editorSource.indexOf('setExportPhase("decode")', dialogCall);
    expect(dialogCall).toBeGreaterThan(-1);
    expect(renderStart).toBeGreaterThan(dialogCall);
    expect(editorSource).toContain("await saveRecordingExportCopy(");
    // "Show in Finder" is localized (src/locales/en/editor.json → toolbar.showInFinder).
    expect(editorSource).toContain('label: t("toolbar.showInFinder")');
    expect(editorSource).toContain("revealRecordingExport(recording.id, exportQuality)");
  });

  test("reveals the latest export by default while retaining the original option", () => {
    expect(editorSource).toContain(
      'defaultRevealExport ? `export:${defaultRevealExport.quality}` : "original"',
    );
    // "Original recording" is localized (src/locales/en/editor.json → toolbar.originalRecording).
    expect(editorSource).toContain('{ label: t("toolbar.originalRecording"), value: "original" }');
  });
});
