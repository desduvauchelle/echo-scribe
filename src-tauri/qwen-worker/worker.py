"""Persistent local Qwen ASR worker; same framed PCM protocol as Whisper."""
import contextlib
import json
import struct
import sys

protocol = sys.stdout

def reply(value):
    protocol.write(json.dumps(value) + "\n")
    protocol.flush()

def read_exact(size):
    data = bytearray()
    while len(data) < size:
        part = sys.stdin.buffer.read(size - len(data))
        if not part:
            raise EOFError("Truncated audio request")
        data.extend(part)
    return data

try:
    with contextlib.redirect_stdout(sys.stderr):
        import mlx.core as mx
        import numpy as np
        from mlx_audio.stt.utils import load_model
        model = load_model(sys.argv[1])
        mx.eval(model.parameters())
        mx.synchronize()
    reply({"ready": True})
    while True:
        header = sys.stdin.buffer.read(4)
        if not header:
            break
        if len(header) != 4:
            raise ValueError("Truncated frame header")
        count = struct.unpack("<I", header)[0]
        if not 0 < count <= 960000:
            raise ValueError("Invalid audio length")
        audio = np.frombuffer(read_exact(count * 4), dtype="<f4").copy()
        if not np.isfinite(audio).all() or np.max(np.abs(audio)) > 1:
            raise ValueError("Invalid audio samples")
        if np.max(np.abs(audio)) < 1e-6:
            reply({"text": "", "segments": []})
            continue
        with contextlib.redirect_stdout(sys.stderr):
            result = model.generate(audio, max_tokens=2048, temperature=0, verbose=False)
            mx.synchronize()
        reply({"text": result.text, "segments": result.segments or []})
except Exception as error:
    reply({"error": str(error)})
    sys.exit(1)
