import Foundation
import AVFoundation
import CoreMedia
import CoreVideo

/// Records a webcam alongside the main screen capture to a standalone
/// `<out-stem>.webcam.mp4` (video-only H.264).
///
/// ## Why this is a raw-frame pipeline (not AVCaptureMovieFileOutput)
///
/// The first version used `AVCaptureMovieFileOutput`. Two real defects came
/// out of a 3-minute recording made with a Logitech C920 on 2026-09-09:
///
///   1. **Frame rate never pinned.** The session preset picked a 1080p format
///      but left the device's `activeVideoMaxFrameDuration` wherever the last
///      client put it (1/24 s — the app's own WebKit self-view had opened the
///      camera concurrently). The file came out at 24 fps with extra drops
///      (mean 44.5 ms/frame, gaps up to 250 ms), which judders badly once the
///      editor zero-order-holds it onto a 30 fps output grid.
///   2. **Offset measured off the wrong instant.** `didStartRecordingTo` fires
///      after the first sample has gone through the encoder and hit the file,
///      so `webcamStart` was late by the pipeline latency and the bubble lagged
///      the audio by that much.
///
/// So this recorder owns the frames: `AVCaptureVideoDataOutput` hands us every
/// captured buffer with its capture-time PTS, we convert that PTS onto the
/// host clock (the same clock the SCStream main capture and the input-event
/// track anchor to), and an `AVAssetWriter` encodes it. That gives us:
///
///   - the device format + frame rate pinned to 30 fps (re-pinned via KVO if
///     another process — the self-view — changes it under us),
///   - an EXACT `offsetMs = firstMainFramePTS − firstWebcamFramePTS` on one
///     clock (both are capture timestamps, no encoder latency in the way),
///   - a sane bitrate (the default MovieFileOutput setting wrote 23 Mbit/s,
///     582 MB for 3 minutes),
///   - pause/resume with the same PTS-shift scheme the main recorder uses, and
///   - per-frame counters (received / appended / dropped by reason / max gap)
///     emitted at finalize so a stuttery file is diagnosable from the log.
///
/// Offset convention (unchanged, consumed by the editor):
///     offsetMs = round((firstMainFrameHostSeconds − webcamFirstFrameHostSeconds) * 1000)
///     webcamTime = mainTime + offsetMs
///
/// Threading: all capture-side state (`writer`, counters, pause clock) is
/// touched only on `captureQ`, the queue the sample-buffer delegate runs on.
/// `pause()`/`resume()`/`finalize()` hop onto it. `firstMainFramePTS` is set
/// from the Recorder's stateQ and guarded by `stateLock`. `finalize()` may be
/// called from the sidecar's main queue; it never runs writer work inline on
/// the caller — it blocks on a semaphore signalled from `captureQ`, which is a
/// park-and-wait that needs nothing from the caller's thread.
@available(macOS 14.0, *)
final class WebcamRecorder: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let webcamURL: URL

    /// Target frame rate. The editor's output grid is 30 fps, so the bubble is
    /// smoothest when the camera delivers exactly one frame per slot.
    static let targetFps: Double = 30
    /// Never capture larger than this (long edge / short edge). 1080p is
    /// already far more than the PiP bubble or a "cut to camera" scene needs.
    static let maxWidth: Int32 = 1920
    static let maxHeight: Int32 = 1080

    private let session = AVCaptureSession()
    private let videoOutput = AVCaptureVideoDataOutput()
    private let device: AVCaptureDevice
    private let captureQ = DispatchQueue(label: "webcam-capture", qos: .userInitiated)

    // Pinned device configuration (what we asked for), for the KVO re-pin.
    private var pinnedFormat: AVCaptureDevice.Format?
    private var pinnedFrameDuration: CMTime = CMTime(value: 1, timescale: 30)
    private var repinObservers: [NSKeyValueObservation] = []
    private var repinning = false
    private var repinCount = 0
    private var lastRepinAt: Double = 0

    // ---- captureQ-only state ------------------------------------------
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var sessionStarted = false
    /// Host-clock seconds of the first APPENDED webcam frame (= file t=0).
    private var firstFrameHostSeconds: Double?
    private var lastAppendedPTS: CMTime = .invalid
    private var lastFrameHostSeconds: Double?
    private var pausedSince: Double?
    private var pausedTotal: Double = 0
    private var stopped = false

    // Counters (captureQ-only), reported at finalize.
    private var framesIn = 0
    private var appended = 0
    private var droppedPaused = 0
    private var droppedNotReady = 0
    private var droppedNonMonotonic = 0
    private var droppedNoBuffer = 0
    private var appendFailures = 0
    private var maxGapMs: Double = 0
    private var gapsOver100ms = 0

    // ---- cross-thread state -------------------------------------------
    private let stateLock = NSLock()
    private var firstMainFramePTS: Double?
    private var started = false

    /// Build the webcam recorder. Returns nil (with a `warn` event already
    /// emitted) if the device can't be found or the session can't be wired up —
    /// callers then proceed WITHOUT a webcam so the recording never breaks.
    init?(webcamURL: URL, uid: String) {
        self.webcamURL = webcamURL

        // Verify camera TCC authorization before touching AVCaptureSession at
        // all. The sidecar is a headless child process spawned by the app —
        // it can never itself trigger the system permission prompt (only
        // requestAccess from the app's own process can), so if the user
        // hasn't granted Camera access yet, building the session would just
        // silently fail later. Fail fast here instead, with a truthful log,
        // and degrade to no-webcam.
        let authStatus = AVCaptureDevice.authorizationStatus(for: .video)
        guard authStatus == .authorized else {
            emit(["event": "warn", "kind": "camera_denied",
                  "msg": "camera permission not granted; recording continues without webcam"])
            return nil
        }

        // Match the camera by uniqueID (what --list-cameras emits). Fall back to
        // the direct initializer, then any discovered video device.
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external, .continuityCamera],
            mediaType: .video,
            position: .unspecified
        )
        let found = discovery.devices.first(where: { $0.uniqueID == uid })
            ?? AVCaptureDevice(uniqueID: uid)
            ?? discovery.devices.first
        guard let cam = found else {
            emit(["event": "warn", "kind": "camera_not_found",
                  "msg": "webcam device not found", "uid": uid])
            return nil
        }
        self.device = cam
        super.init()

        session.beginConfiguration()
        // (No sessionPreset: on macOS the device's activeFormat, pinned below,
        // is honoured directly — `.inputPriority` is iOS-only.)

        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: cam)
        } catch {
            session.commitConfiguration()
            emit(["event": "warn", "kind": "camera_input",
                  "msg": "webcam input init failed", "err": error.localizedDescription])
            return nil
        }
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            emit(["event": "warn", "kind": "camera_input", "msg": "cannot add webcam input to session"])
            return nil
        }
        session.addInput(input)

        // VIDEO ONLY — the mic is already captured in the main mix.
        videoOutput.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ]
        // If the encoder falls behind, drop the late frame rather than queue
        // it: a dropped frame is a hold in the bubble; a growing queue is
        // drift that never recovers.
        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.setSampleBufferDelegate(self, queue: captureQ)
        guard session.canAddOutput(videoOutput) else {
            session.commitConfiguration()
            emit(["event": "warn", "kind": "camera_output", "msg": "cannot add webcam video output to session"])
            return nil
        }
        session.addOutput(videoOutput)
        session.commitConfiguration()

        // Pin format + frame rate AFTER the input is attached (attaching can
        // reset the device's active format).
        pinDeviceConfiguration(reason: "initial")
        installRepinObservers()

        emit(["event": "webcam_ready", "device": cam.localizedName, "uid": cam.uniqueID,
              "format": Self.describe(format: cam.activeFormat),
              "target_fps": Self.targetFps])
    }

    // MARK: - Device format / frame-rate pinning

    private static func describe(format: AVCaptureDevice.Format) -> String {
        let d = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        let st = CMFormatDescriptionGetMediaSubType(format.formatDescription)
        let cc = String(bytes: [UInt8(st >> 24 & 255), UInt8(st >> 16 & 255), UInt8(st >> 8 & 255), UInt8(st & 255)],
                        encoding: .ascii) ?? "?"
        let maxFps = format.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 0
        return "\(d.width)x\(d.height) \(cc) max\(Int(maxFps.rounded()))fps"
    }

    /// The frame-rate range of `format` that can run at `fps`, if any. Cameras
    /// advertise slightly-off nominal rates (the C920 reports 30.00003 fps), so
    /// the match is tolerant — and the pin below must use the range's OWN
    /// `minFrameDuration`, never a hand-built 1/30: AVFoundation throws an
    /// NSInvalidArgumentException ("Not supported - Supported ranges") for a
    /// duration that isn't exactly one the device listed, which took the whole
    /// sidecar down on 2026-09-09.
    private static func range(of format: AVCaptureDevice.Format, at fps: Double) -> AVFrameRateRange? {
        format.videoSupportedFrameRateRanges.first { r in
            r.minFrameRate <= fps + 0.01 && r.maxFrameRate >= fps - 0.01
        }
    }

    /// Choose the largest format ≤ 1080p that can run at `targetFps`, preferring
    /// the 420v pixel layout (what we ask the output for, so no conversion).
    /// Falls back to the largest ≤ 1080p format at its own max rate when no
    /// format reaches 30 fps. Returns the format plus the frame rate to pin.
    private static func pickFormat(for device: AVCaptureDevice) -> (AVCaptureDevice.Format, AVFrameRateRange)? {
        func area(_ f: AVCaptureDevice.Format) -> Int {
            let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            return Int(d.width) * Int(d.height)
        }
        func fits(_ f: AVCaptureDevice.Format) -> Bool {
            let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            return d.width <= maxWidth && d.height <= maxHeight
        }
        func is420v(_ f: AVCaptureDevice.Format) -> Bool {
            CMFormatDescriptionGetMediaSubType(f.formatDescription) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        }
        let candidates = device.formats.filter(fits)
        let at30 = candidates.filter { range(of: $0, at: targetFps) != nil }
        if let best = at30.max(by: { a, b in
            (area(a), is420v(a) ? 1 : 0) < (area(b), is420v(b) ? 1 : 0)
        }), let r = range(of: best, at: targetFps) {
            return (best, r)
        }
        guard let largest = candidates.max(by: { area($0) < area($1) }),
              let fastest = largest.videoSupportedFrameRateRanges.max(by: { $0.maxFrameRate < $1.maxFrameRate })
        else { return nil }
        return (largest, fastest)
    }

    /// Lock the device to the chosen format and a FIXED frame duration
    /// (min == max), so the camera can't fall back to 24/20/15 fps under auto
    /// exposure or a neighbouring client's looser request.
    private func pinDeviceConfiguration(reason: String) {
        guard let (format, range) = Self.pickFormat(for: device) else {
            emit(["event": "warn", "kind": "camera_format",
                  "msg": "no usable webcam format found; using device default",
                  "active": Self.describe(format: device.activeFormat)])
            return
        }
        // Fastest rate of the chosen range, expressed with the device's own
        // CMTime (see `range(of:at:)` — a hand-built 1/30 throws).
        let dur = range.minFrameDuration
        let fps = range.maxFrameRate
        do {
            try device.lockForConfiguration()
            repinning = true
            if device.activeFormat != format { device.activeFormat = format }
            device.activeVideoMinFrameDuration = dur
            device.activeVideoMaxFrameDuration = dur
            repinning = false
            device.unlockForConfiguration()
            pinnedFormat = format
            pinnedFrameDuration = dur
            emit(["event": "diag", "phase": "webcam_pinned", "reason": reason,
                  "format": Self.describe(format: format), "fps": fps])
        } catch {
            repinning = false
            emit(["event": "warn", "kind": "camera_format",
                  "msg": "webcam lockForConfiguration failed; frame rate not pinned",
                  "err": error.localizedDescription])
        }
    }

    /// Another process sharing the camera (the app's own self-view webview)
    /// can rewrite the device's active format / frame durations at any time.
    /// Watch for that and re-pin, bounded so two clients can't ping-pong
    /// forever: at most one re-pin per second and 30 total per recording.
    private func installRepinObservers() {
        let handler: (AVCaptureDevice, Any) -> Void = { [weak self] dev, _ in
            guard let self = self else { return }
            self.captureQ.async { self.repinIfDrifted() }
        }
        repinObservers = [
            device.observe(\.activeFormat, options: [.new], changeHandler: handler),
            device.observe(\.activeVideoMinFrameDuration, options: [.new], changeHandler: handler),
            device.observe(\.activeVideoMaxFrameDuration, options: [.new], changeHandler: handler),
        ]
    }

    private func repinIfDrifted() {
        if repinning || stopped { return }
        guard let want = pinnedFormat else { return }
        let fmtOk = device.activeFormat == want
        let minOk = CMTimeCompare(device.activeVideoMinFrameDuration, pinnedFrameDuration) == 0
        let maxOk = CMTimeCompare(device.activeVideoMaxFrameDuration, pinnedFrameDuration) == 0
        if fmtOk && minOk && maxOk { return }
        let now = CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock()))
        emit(["event": "warn", "kind": "camera_format_drift",
              "msg": "webcam format/frame rate changed by another client",
              "active": Self.describe(format: device.activeFormat),
              "min_dur": CMTimeGetSeconds(device.activeVideoMinFrameDuration),
              "max_dur": CMTimeGetSeconds(device.activeVideoMaxFrameDuration),
              "repins": repinCount])
        guard repinCount < 30, now - lastRepinAt >= 1.0 else { return }
        repinCount += 1
        lastRepinAt = now
        pinDeviceConfiguration(reason: "drift")
    }

    // MARK: - Lifecycle

    private func nowHostSeconds() -> Double {
        CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock()))
    }

    /// Start the capture session. Called BEFORE SCStream starts so the webcam
    /// is already rolling when the first main frame lands. The writer is built
    /// lazily on the first delivered frame (its true pixel dimensions).
    func start() {
        try? FileManager.default.removeItem(at: webcamURL)
        session.startRunning()
        stateLock.lock()
        started = true
        stateLock.unlock()
        // The pinned durations can be reset by startRunning on some drivers;
        // check once the session is live.
        captureQ.async { [self] in repinIfDrifted() }
    }

    /// Record the main capture's first-frame PTS (host-clock seconds). Called
    /// once from the Recorder's stateQ on the first complete video frame.
    func markMainFirstFrame(ptsSeconds: Double) {
        stateLock.lock()
        if firstMainFramePTS == nil { firstMainFramePTS = ptsSeconds }
        stateLock.unlock()
    }

    /// Pause: frames delivered while paused are dropped and the paused wall
    /// time is later subtracted from every appended PTS, so the file's
    /// timeline stays continuous (the gap is elided, exactly like the main
    /// recorder). `webcam_offset_ms` stays valid across a pause because both
    /// files elide the same interval and neither file's t=0 moves.
    func pause() {
        captureQ.async { [self] in
            if pausedSince == nil && !stopped { pausedSince = nowHostSeconds() }
        }
    }

    func resume() {
        captureQ.async { [self] in
            if let since = pausedSince {
                pausedTotal += max(0, nowHostSeconds() - since)
                pausedSince = nil
            }
        }
    }

    // MARK: - Frame delivery (captureQ)

    private func setupWriter(width: Int, height: Int) throws {
        let w = try AVAssetWriter(outputURL: webcamURL, fileType: .mp4)
        // ~0.13 bit/pixel/frame → 8 Mbit/s at 1080p30. Plenty for a talking
        // head; the previous default wrote ~23 Mbit/s for no visible gain.
        let bitrate = max(2_000_000, min(12_000_000, Int(Double(width * height) * Self.targetFps * 0.13)))
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoExpectedSourceFrameRateKey: Int(Self.targetFps),
                AVVideoMaxKeyFrameIntervalKey: Int(Self.targetFps) * 2,
                // No B-frames: keeps encode latency low and the editor's
                // demux → WebCodecs path trivially in presentation order.
                AVVideoAllowFrameReorderingKey: false,
            ],
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        guard w.canAdd(input) else {
            throw NSError(domain: "screenrec", code: 10,
                          userInfo: [NSLocalizedDescriptionKey: "cannot add webcam video input"])
        }
        w.add(input)
        // The adaptor MUST be created before startWriting() — AVFoundation
        // throws NSInvalidArgumentException otherwise (hit on 2026-09-09).
        let pba = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        guard w.startWriting() else {
            throw NSError(domain: "screenrec", code: 11,
                          userInfo: [NSLocalizedDescriptionKey: w.error?.localizedDescription ?? "webcam startWriting failed"])
        }
        writer = w
        videoInput = input
        adaptor = pba
        emit(["event": "diag", "phase": "webcam_writer_ready", "w": width, "h": height, "bitrate": bitrate])
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        if stopped { return }
        framesIn += 1
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            droppedNoBuffer += 1
            return
        }

        // Capture-time PTS on the session's clock → host clock, the clock the
        // SCStream PTS / input events / firstMainFramePTS all live on.
        var pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if let syncClock = session.synchronizationClock {
            pts = CMSyncConvertTime(pts, from: syncClock, to: CMClockGetHostTimeClock())
        }
        let hostSeconds = CMTimeGetSeconds(pts)

        // Delivery-gap tracking (on the raw capture clock, before pause
        // elision), so a camera that stalls shows up as max_gap_ms.
        if let last = lastFrameHostSeconds, pausedSince == nil {
            let gapMs = (hostSeconds - last) * 1000
            if gapMs > maxGapMs { maxGapMs = gapMs }
            if gapMs > 100 { gapsOver100ms += 1 }
        }
        lastFrameHostSeconds = hostSeconds

        if pausedSince != nil {
            droppedPaused += 1
            return
        }

        if writer == nil {
            let w = CVPixelBufferGetWidth(pixelBuffer)
            let h = CVPixelBufferGetHeight(pixelBuffer)
            do {
                try setupWriter(width: w, height: h)
            } catch {
                emit(["event": "warn", "kind": "camera_writer",
                      "msg": "webcam writer setup failed; recording continues without webcam",
                      "err": error.localizedDescription])
                stopped = true
                return
            }
        }
        guard let writer = writer, let input = videoInput, let adaptor = adaptor else { return }

        if !sessionStarted {
            writer.startSession(atSourceTime: pts)
            sessionStarted = true
            firstFrameHostSeconds = hostSeconds
            emit(["event": "webcam_recording", "path": webcamURL.path,
                  "first_frame_host_s": hostSeconds])
        }

        // Elide paused time so the file timeline is continuous.
        let shift = CMTime(seconds: pausedTotal, preferredTimescale: pts.timescale)
        let outPTS = pausedTotal > 0 ? CMTimeSubtract(pts, shift) : pts
        if lastAppendedPTS.isValid && CMTimeCompare(outPTS, lastAppendedPTS) <= 0 {
            droppedNonMonotonic += 1
            return
        }
        guard input.isReadyForMoreMediaData else {
            droppedNotReady += 1
            return
        }
        if adaptor.append(pixelBuffer, withPresentationTime: outPTS) {
            appended += 1
            lastAppendedPTS = outPTS
        } else {
            appendFailures += 1
            if appendFailures == 1 {
                emit(["event": "warn", "kind": "camera_append",
                      "msg": "webcam frame append failed",
                      "writer_status": writer.status.rawValue,
                      "err": writer.error?.localizedDescription ?? ""])
            }
        }
    }

    // MARK: - Finalize

    /// Stop the webcam cleanly and wait (bounded) for the file to finalize.
    /// Returns (path, offsetMs). `path` is "" when no usable file was produced;
    /// `offsetMs` is 0 when the timing couldn't be determined. Never hangs: the
    /// finish wait is capped at ~3s, after which we report the file anyway if it
    /// exists on disk. Safe to call from any thread, including main: all writer
    /// work runs on captureQ and the caller only parks on a semaphore.
    func finalize() -> (path: String, offsetMs: Int) {
        let wasStarted: Bool = {
            stateLock.lock(); defer { stateLock.unlock() }
            return started
        }()
        guard wasStarted else { return ("", 0) }

        repinObservers.forEach { $0.invalidate() }
        repinObservers = []

        let doneSem = DispatchSemaphore(value: 0)
        var finished = false
        var stats: [String: Any] = [:]
        var firstHost: Double?
        var hadWriter = false

        captureQ.async { [self] in
            stopped = true
            // Stop delivering frames before closing the writer. stopRunning is
            // synchronous and may take a moment; it's off the caller's thread.
            session.stopRunning()
            hadWriter = writer != nil
            firstHost = firstFrameHostSeconds
            let durS: Double = {
                guard let f = firstFrameHostSeconds, lastAppendedPTS.isValid else { return 0 }
                return CMTimeGetSeconds(lastAppendedPTS) - f + pausedTotal
            }()
            stats = [
                "frames_in": framesIn,
                "appended": appended,
                "dropped_paused": droppedPaused,
                "dropped_not_ready": droppedNotReady,
                "dropped_non_monotonic": droppedNonMonotonic,
                "dropped_no_buffer": droppedNoBuffer,
                "append_failures": appendFailures,
                "max_gap_ms": (maxGapMs * 10).rounded() / 10,
                "gaps_over_100ms": gapsOver100ms,
                "measured_fps": durS > 0 ? (Double(appended) / (durS - pausedTotal) * 10).rounded() / 10 : 0,
                "paused_total_s": (pausedTotal * 100).rounded() / 100,
                "repins": repinCount,
            ]
            guard let writer = writer, let input = videoInput, sessionStarted else {
                doneSem.signal()
                return
            }
            input.markAsFinished()
            writer.finishWriting {
                finished = writer.status == .completed
                if let err = writer.error {
                    emit(["event": "warn", "kind": "camera_finish",
                          "msg": "webcam writer finish reported error", "err": err.localizedDescription,
                          "status": writer.status.rawValue])
                }
                doneSem.signal()
            }
        }
        if doneSem.wait(timeout: .now() + 4.0) == .timedOut {
            emit(["event": "warn", "kind": "camera_finish_timeout",
                  "msg": "webcam did not confirm finish within 4s; reporting file if present"])
        }

        emit(["event": "diag", "phase": "webcam_stats"].merging(stats) { a, _ in a })

        let fileExists = FileManager.default.fileExists(atPath: webcamURL.path)
        guard hadWriter, fileExists else {
            emit(["event": "warn", "kind": "camera_no_file",
                  "msg": hadWriter ? "webcam file not produced" : "webcam delivered no frames; no file"])
            try? FileManager.default.removeItem(at: webcamURL)
            return ("", 0)
        }
        if !finished {
            emit(["event": "warn", "kind": "camera_finish_incomplete",
                  "msg": "webcam writer did not reach completed; file may be unplayable"])
        }

        let mainPTS: Double? = {
            stateLock.lock(); defer { stateLock.unlock() }
            return firstMainFramePTS
        }()
        var offsetMs = 0
        if let f = firstHost, let m = mainPTS {
            offsetMs = Int(((m - f) * 1000.0).rounded())
        } else {
            emit(["event": "warn", "kind": "camera_offset_unknown",
                  "msg": "webcam offset unknown (missing first webcam frame or main first-frame timestamp)",
                  "have_start": firstHost != nil, "have_main_pts": mainPTS != nil])
        }
        emit(["event": "webcam_finalized", "path": webcamURL.path, "offset_ms": offsetMs])
        return (webcamURL.path, offsetMs)
    }
}
