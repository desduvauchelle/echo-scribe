# Local wake-word detector

The Tucky keyword worker uses sherpa-onnx 1.13.8 (Apache-2.0):
https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8

The bundled acoustic model is
`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`, published by
the sherpa-onnx project. Its original model card is included as MODEL-CARD.md
and declares Apache License 2.0. Model documentation and archive:

- https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html#sherpa-onnx-kws-zipformer-gigaspeech-3-3m-2024-01-01-english
- https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2

Archive SHA-256: `f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a`.

Encoder, decoder, and joiner are the original quantized chunk-16/left-64
artifacts, renamed for packaging. Tucky's keyword file encodes TUCKY as
`▁T U CK Y` using the publisher's BPE model. No weights were modified.

The separate worker keeps its ONNX runtime isolated from Tucky's transcription
runtime. It receives in-memory audio over a local pipe. It has no microphone,
network, or audio-file write capability in its application code.
