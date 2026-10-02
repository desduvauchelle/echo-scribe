"""Offline acoustic smoke checks using macOS synthetic speech, never the mic.

Build the detector with scripts/build-wakeword.sh first. These fixtures exercise
the actual framed-PCM worker protocol, including immediate speech after ready.
They do not replace real voice, room-noise, or battery acceptance testing.
"""
import array
import argparse
import json
from pathlib import Path
import platform
import struct
import subprocess
import sys
import tempfile
import time
import wave

ROOT = Path(__file__).resolve().parents[1]
TRIPLE = "aarch64-apple-darwin" if platform.machine() == "arm64" else "x86_64-apple-darwin"
BINARY = ROOT / "src-tauri/binaries" / f"tucky-wakeword-{TRIPLE}"
MODELS = ROOT / "src-tauri/resources/wakeword"


def frames(pcm):
    out = bytearray()
    for start in range(0, len(pcm), 320):
        chunk = pcm[start:start + 320]
        out.extend(struct.pack("<II", 16000, len(chunk)))
        out.extend(struct.pack(f"<{len(chunk)}f", *chunk))
    return out


def detect(pcm):
    before = time.monotonic()
    result = subprocess.run([str(BINARY), str(MODELS)], input=frames(pcm),
                            capture_output=True, check=True, timeout=30)
    lines = result.stdout.decode().splitlines()
    assert lines and lines[0] == "ready", result.stderr.decode()
    return lines.count("wake"), round(time.monotonic() - before, 3)


def synthesize(directory, voice, text, index):
    aiff = directory / f"{index}.aiff"
    wav = directory / f"{index}.wav"
    subprocess.run(["say", "-v", voice, "-o", str(aiff), text], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(aiff),
                    "-ar", "16000", "-ac", "1", str(wav)], check=True)
    with wave.open(str(wav), "rb") as audio:
        samples = array.array("h", audio.readframes(audio.getnframes()))
        if sys.byteorder != "little":
            samples.byteswap()
    return [x / 32768.0 for x in samples]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asr", type=Path, help="Path to built check_wake_transcript example")
    parser.add_argument("--model", help="Speech model ID to pass to the ASR example")
    parser.add_argument("--output", type=Path, help="Keep synthetic fixtures for diagnosis")
    args = parser.parse_args()
    cases = [(voice, phrase, True)
             for voice in ("Samantha", "Daniel", "Karen")
             for phrase in ("Tucky, open Safari.", "Tucky save a task to review the proposal.",
                            "Hey Tucky, create a task to review the proposal.",
                            "Hey Tucky, start dictating.", "Hey Tucky, focus on Safari.")]
    cases += [("Samantha", phrase, False) for phrase in (
        "Open Safari.", "We will review the proposal tomorrow.",
        "Kentucky is a state.", "Keep my computer awake for two hours.",
        "The turkey is ready.")]
    report = []
    with tempfile.TemporaryDirectory(prefix="tucky-wake-test-") as temporary:
        directory = args.output or Path(temporary)
        directory.mkdir(parents=True, exist_ok=True)
        for index, (voice, phrase, expected) in enumerate(cases):
            pcm = synthesize(Path(directory), voice, phrase, index) + [0.0] * 24000
            wakes, elapsed = detect(pcm)
            # "Kentucky" is a known acoustic candidate. The separate transcript
            # gate must reject it; --asr exercises that actual second stage.
            expected_candidates = int(expected or phrase == "Kentucky is a state.")
            report.append(dict(voice=voice, phrase=phrase, expected=expected,
                               expected_candidates=expected_candidates, wakes=wakes,
                               seconds=elapsed, passed=(wakes == expected_candidates)))
        wakes, elapsed = detect([0.0] * (16000 * 65))
        report.append(dict(phrase="65 seconds of silence", wakes=wakes,
                           seconds=elapsed, passed=wakes == 0))
        if args.asr:
            paths = [str(directory / f"{index}.wav") for index in range(len(cases))]
            model_args = ["--model", args.model] if args.model else []
            result = subprocess.run([str(args.asr), *model_args, *paths], capture_output=True,
                                    check=True, timeout=180)
            transcripts = json.loads(result.stdout)
            assert len(transcripts) == len(cases), "ASR omitted fixtures"
            for row, transcription in zip(report, transcripts):
                row.update(transcript=transcription["transcript"], command=transcription["command"], action_type=transcription["action_type"])
                row["passed"] = row["passed"] and bool(row["wakes"] and row["command"]) == row["expected"]
                expected_action = ("save_capture" if "task" in row["phrase"] else
                                   "start_dictation" if "start dictating" in row["phrase"] else
                                   "focus_window" if "focus on" in row["phrase"] else None)
                if expected_action:
                    row["passed"] = row["passed"] and row["action_type"] == expected_action
    print(json.dumps(report, indent=2))
    return 0 if all(row["passed"] for row in report) else 1


if __name__ == "__main__":
    sys.exit(main())
