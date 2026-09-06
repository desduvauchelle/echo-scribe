import AudioCommon
import CoreAudio
import Foundation
import PersonaPlex

struct ChatOptions {
    var modelId = PersonaPlexModel.modelId8bit
    var modelDir: URL
    var voice: PersonaPlexVoice = .NATF2
    var prompt: String?
    /// Apple Voice Processing (echo cancellation) on the mic. Lets the user talk
    /// over speakers; turn off for headphones if the processing colours the
    /// audio too much.
    var aec = true
    /// CoreAudio device UID or name; nil = system default input.
    var inputDevice: String?
    var maxSteps = Int.max
    var warmup = true
    /// Headless test mode: feed a WAV instead of the mic, write the agent's
    /// audio to `outputWav`, never touch audio devices.
    var inputWav: URL?
    var outputWav: URL?
    /// File mode only: keep generating this many 80 ms frames after the input
    /// runs out (60 ≈ 5 s) so the agent can finish its reply.
    var postSteps = 60
    /// File mode variant that feeds the WAV at real time (1920 samples every
    /// 80 ms) and paces the model to it — exercises the live-session timing
    /// without a microphone.
    var realtimeFile = false
}

/// Runs one full-duplex conversation: load → warm up → stream mic frames in,
/// agent frames out, text tokens as they are sampled. Returns the process exit
/// code.
enum ChatRunner {
    static func run(_ o: ChatOptions, stop: StopFlag) async -> Int32 {
        let sink = EventSink.shared

        // 1. Load weights from Tucky's model directory (never downloads here).
        sink.emit(["event": "loading", "fraction": 0.0, "status": "Loading PersonaPlex"])
        let t0 = Date()
        let model: PersonaPlexModel
        do {
            model = try await PersonaPlexModel.fromPretrained(
                modelId: o.modelId,
                cacheDir: o.modelDir,
                offlineMode: true
            ) { fraction, status in
                // Upstream labels its offline cache check "Downloading…"; nothing
                // is fetched here (offlineMode), so say what actually happens.
                let label = status.hasPrefix("Downloading") ? "Checking weights on disk" : status
                sink.emit(["event": "loading", "fraction": fraction, "status": label])
            }
        } catch {
            sink.error("model load failed: \(error.localizedDescription) [\(error)]")
            return 2
        }
        let loadSecs = Date().timeIntervalSince(t0)
        sink.log("info", String(format: "model loaded in %.1fs", loadSecs))
        if let why = stop.stopReason {
            sink.emit(["event": "stopped", "reason": why, "steps": 0])
            return 0
        }

        // 2. Warm up: traces the compiled temporal transformer + JIT shaders.
        var warmSecs = 0.0
        if o.warmup {
            sink.emit(["event": "warming"])
            let t1 = Date()
            await Task.detached(priority: .userInitiated) { model.warmUp() }.value
            warmSecs = Date().timeIntervalSince(t1)
            sink.log("info", String(format: "warm-up done in %.1fs", warmSecs))
        }
        if let why = stop.stopReason {
            sink.emit(["event": "stopped", "reason": why, "steps": 0])
            return 0
        }

        // 3. Transcript decoder + persona prompt.
        let spmPath = o.modelDir.appendingPathComponent("tokenizer_spm_32k_3.model").path
        let decoder = try? StreamingTextDecoder(modelPath: spmPath)
        if decoder == nil {
            sink.log("warn", "tokenizer not readable at \(spmPath); transcript disabled")
        }
        var promptTokens: [Int32]?
        if let prompt = o.prompt,
           !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            promptTokens = model.tokenizeSystemPrompt(prompt)
            if promptTokens == nil {
                sink.log("warn", "tokenizer missing; falling back to the built-in default prompt")
            }
        }

        // 4. Audio I/O: live devices, or a WAV in file mode.
        let ring: AudioRingBuffer
        var audio: FullDuplexAudioIO?
        var micName = "file"
        var fileFrames = 0
        var feeder: Thread?
        let feederStop = StopFlag()
        if let wav = o.inputWav {
            let samples: [Float]
            do {
                samples = try AudioFileLoader.load(url: wav, targetSampleRate: 24000)
            } catch {
                sink.error("cannot read \(wav.path): \(error.localizedDescription)")
                return 2
            }
            fileFrames = (samples.count + 1919) / 1920
            if o.realtimeFile {
                // Live-session simulation: the "microphone" delivers one 80 ms
                // frame every 80 ms, then silence.
                let paced = AudioRingBuffer(capacity: 24000 * 5)
                ring = paced
                let t = Thread {
                    var offset = 0
                    let frame = 1920
                    let started = Date()
                    var n = 0
                    while feederStop.stopReason == nil {
                        let end = min(offset + frame, samples.count)
                        if offset < end {
                            paced.write(Array(samples[offset..<end]))
                        } else {
                            paced.write([Float](repeating: 0, count: frame))
                        }
                        offset = end
                        n += 1
                        let due = started.addingTimeInterval(Double(n) * 0.08)
                        let sleep = due.timeIntervalSinceNow
                        if sleep > 0 { Thread.sleep(forTimeInterval: sleep) }
                    }
                }
                t.name = "wav-feeder"
                t.start()
                feeder = t
                sink.log("info", "realtime file mode: \(samples.count) samples, \(fileFrames) frames from \(wav.lastPathComponent), fed at 24 kHz")
            } else {
                ring = AudioRingBuffer(capacity: samples.count + 24000 * 10)
                ring.write(samples)
                sink.log("info", "file mode: \(samples.count) samples, \(fileFrames) frames from \(wav.lastPathComponent)")
            }
        } else {
            let liveRing = AudioRingBuffer(capacity: 24000 * 5)
            ring = liveRing
            var deviceID: UInt32?
            if let key = o.inputDevice?.trimmingCharacters(in: .whitespaces), !key.isEmpty {
                if let d = AudioDevices.resolve(key) {
                    deviceID = UInt32(d.id)
                    sink.log("info", "input device '\(key)' → \(d.name) [\(d.uid)]")
                } else {
                    sink.log("warn", "input device '\(key)' not found; using the system default")
                }
            }
            func makeIO(_ device: UInt32?) -> FullDuplexAudioIO {
                FullDuplexAudioIO(configuration: .init(
                    inputSampleRate: 24000,
                    outputSampleRate: 24000,
                    inputBufferFrames: 1024,
                    playbackPrebufferFrames: 3,
                    enableAEC: o.aec,
                    inputDeviceID: device))
            }
            var io = makeIO(deviceID)
            do {
                try io.start { samples in liveRing.write(samples) }
            } catch {
                if deviceID != nil {
                    // A device that refuses to pin (unplugged between listing
                    // and start, or one Voice Processing won't take) must not
                    // kill the session: fall back to the default input.
                    sink.log("warn", "selected input device failed (\(error.localizedDescription)); retrying with the system default")
                    io = makeIO(nil)
                    do {
                        try io.start { samples in liveRing.write(samples) }
                    } catch {
                        sink.error("microphone/speaker setup failed: \(error.localizedDescription) [\(error)]")
                        return 3
                    }
                } else {
                    sink.error("microphone/speaker setup failed: \(error.localizedDescription) [\(error)]")
                    return 3
                }
            }
            audio = io
            micName = io.currentInputDeviceID().flatMap { AudioDevices.name(for: AudioDeviceID($0)) } ?? io.microphoneName
            sink.log("info", "audio running: mic=\(micName) aec=\(o.aec)")
        }

        let maxSteps = o.inputWav != nil ? fileFrames + o.postSteps : o.maxSteps
        let paced = o.inputWav == nil || o.realtimeFile
        sink.emit([
            "event": "ready",
            "paced": paced,
            "mic": micName,
            "load_secs": loadSecs,
            "warm_secs": warmSecs,
            "voice": o.voice.rawValue,
            "aec": o.aec,
            "prompt_tokens": promptTokens?.count ?? 0,
            "max_steps": maxSteps == Int.max ? -1 : maxSteps,
        ])

        // 5. Generate. Text tokens arrive on the inference thread via the
        //    (patched) callback; audio frames stream out one 80 ms frame per step.
        let stream = model.respondRealtime(
            voice: o.voice,
            systemPromptTokens: promptTokens,
            userAudioBuffer: ring,
            maxSteps: maxSteps,
            verbose: false,
            paceToInput: paced
        ) { token in
            if let piece = decoder?.piece(for: token) {
                sink.emit(["event": "text", "text": piece, "token": Int(token)])
            }
        }

        let output = OutputCollector(audio: audio, collect: o.outputWav != nil)
        let consumer = Task.detached(priority: .userInitiated) { () -> Int32 in
            var step = 0
            let started = Date()
            var lastLevelAt = started
            var lastStatsAt = started
            var stepsAtLastStats = 0
            // Mic diagnostics per stats window: peak RMS and how many steps had
            // audible input — the difference between "not hearing you" and
            // "hearing you but ignoring you" lives here.
            var micPeak: Float = 0
            var micActiveSteps = 0
            do {
                for try await frame in stream {
                    step += 1
                    output.push(frame)
                    let now = Date()
                    let micLevel = audio?.statistics().microphoneLevel ?? 0
                    micPeak = max(micPeak, micLevel)
                    if micLevel > 0.01 { micActiveSteps += 1 }
                    if now.timeIntervalSince(lastLevelAt) >= 0.25 {
                        lastLevelAt = now
                        sink.emit([
                            "event": "level",
                            "mic": micLevel,
                            "agent": rms(frame),
                        ])
                    }
                    if step % 25 == 0 {
                        let dt = now.timeIntervalSince(lastStatsAt)
                        let n = max(step - stepsAtLastStats, 1)
                        let stats = audio?.statistics()
                        let queued = max((stats?.scheduledBuffers ?? 0) - (stats?.completedBuffers ?? 0), 0)
                        sink.emit([
                            "event": "stats",
                            "step": step,
                            "ms_per_step": dt / Double(n) * 1000,
                            "elapsed_secs": now.timeIntervalSince(started),
                            "underruns": stats?.underruns ?? 0,
                            "mic_peak": micPeak,
                            "mic_active_pct": Int(Double(micActiveSteps) / Double(n) * 100),
                            "mic_buffer_ms": ring.available / 24,
                            "queued_frames": queued,
                        ])
                        micPeak = 0
                        micActiveSteps = 0
                        lastStatsAt = now
                        stepsAtLastStats = step
                    }
                }
                return 0
            } catch is CancellationError {
                return 0
            } catch {
                sink.error("inference failed: \(error.localizedDescription) [\(error)]")
                return 4
            }
        }
        stop.onStop { consumer.cancel() }
        let code = await consumer.value
        feederStop.requestStop("session-ended")
        _ = feeder
        audio?.stop()

        if let out = o.outputWav {
            do {
                try WAVWriter.write(samples: output.samples, sampleRate: 24000, to: out)
                sink.log("info", "wrote \(out.path) (\(output.samples.count) samples)")
            } catch {
                sink.error("cannot write \(out.path): \(error.localizedDescription)")
            }
        }
        sink.emit([
            "event": "stopped",
            "reason": stop.stopReason ?? (code == 0 ? "finished" : "error"),
            "steps": output.frames,
        ])
        return code
    }
}

/// Fans agent frames out to the speaker and (in file mode) an in-memory WAV.
final class OutputCollector: @unchecked Sendable {
    private let audio: FullDuplexAudioIO?
    private let collect: Bool
    private let lock = NSLock()
    private var _samples: [Float] = []
    private var _frames = 0

    init(audio: FullDuplexAudioIO?, collect: Bool) {
        self.audio = audio
        self.collect = collect
    }

    func push(_ frame: [Float]) {
        audio?.schedulePlayback(frame)
        lock.lock()
        _frames += 1
        if collect { _samples.append(contentsOf: frame) }
        lock.unlock()
    }

    var samples: [Float] {
        lock.lock()
        defer { lock.unlock() }
        return _samples
    }

    var frames: Int {
        lock.lock()
        defer { lock.unlock() }
        return _frames
    }
}

func rms(_ samples: [Float]) -> Float {
    guard !samples.isEmpty else { return 0 }
    var sum: Float = 0
    for s in samples { sum += s * s }
    return (sum / Float(samples.count)).squareRoot()
}
