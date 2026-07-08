import Foundation
import AVFoundation
import CoreMedia

/// Records a webcam alongside the main screen capture to a standalone
/// `<out-stem>.webcam.mp4` (video-only H.264 via AVCaptureMovieFileOutput).
///
/// The webcam runs on its own AVCaptureSession clock, independent of the
/// SCStream main-capture clock. To let the editor line the two up we record a
/// single scalar: `offsetMs`, the host-clock delta between the webcam file's
/// start and the main capture's first frame:
///
///     offsetMs = round((firstMainFrameHostSeconds − webcamStartHostSeconds) * 1000)
///
/// Both terms live on the same host clock:
///   - `webcamStartHostSeconds` is sampled in `fileOutput(_:didStartRecordingTo:)`
///     from `CMClockGetHostTimeClock()`.
///   - `firstMainFrameHostSeconds` is the SCStream first-frame PTS (seconds),
///     which is also host-clock-based — the same family the input-event
///     recorder anchors to.
///
/// Threading: `AVCaptureMovieFileOutput` has no API to pin its recording
/// delegate to a queue we choose — `didStartRecordingTo`/`didFinishRecordingTo`
/// arrive wherever AVFoundation decides to deliver them. We established
/// empirically (small standalone harnesses against the real camera + SDK, not
/// just reading docs) that `didFinishRecordingTo` fires synchronously, inline,
/// on whatever thread calls `stopRecording()` — so the delegate callback runs
/// on the SAME thread that's about to block waiting for it. `finalize()` can
/// itself be invoked from the sidecar's main queue (SIGTERM handler,
/// `didStopWithError`), so calling `stopRecording()` + `finishSem.wait()`
/// straight off the caller's thread risks a main-thread self-deadlock if that
/// caller is main.
///
/// Naively hopping to a dedicated queue via `finalizeQ.sync { … }` does NOT
/// fix this: GCD is free to (and empirically does, verified with a standalone
/// harness) run a `sync` block inline on the calling thread when the target
/// queue is otherwise idle, so `stopRecording()` would still execute on main.
/// The fix that actually forces the call off the caller's thread is
/// `finalizeQ.async { … }` paired with a plain `DispatchSemaphore.wait()` on
/// the caller side: `async` is verified (same harness) to always run on a
/// separate GCD worker thread, and blocking the caller on an *outer* semaphore
/// (signalled once the async block finishes) never requires the caller's own
/// thread to execute anything, so it's safe to park regardless of which
/// thread that is. `firstMainFramePTS` is written once from the main
/// Recorder's stateQ. A dedicated lock (`stateLock`) guards every shared
/// scalar so the offset read at finalize can't race the delegate callbacks.
/// The design is intentionally isolated from the Recorder's `stateQ` so the
/// webcam can never stall or deadlock the main video/audio path.
@available(macOS 14.0, *)
final class WebcamRecorder: NSObject, AVCaptureFileOutputRecordingDelegate {
    let webcamURL: URL

    private let session = AVCaptureSession()
    private let movieOutput = AVCaptureMovieFileOutput()

    // Dedicated serial queue that owns stopRecording() + the bounded finish
    // wait in finalize(), so that work never runs on the caller's thread (which
    // may be the sidecar's main queue — see the threading note above).
    private let finalizeQ = DispatchQueue(label: "webcam-finalize")

    // AVCaptureFileOutput delivers its recording-delegate callbacks on
    // whatever thread called start/stopRecording; stateLock makes the handoff
    // to finalize() safe regardless.
    private let stateLock = NSLock()
    // Host-clock seconds when the movie file actually began recording.
    private var webcamStartHostSeconds: Double?
    // Host-clock seconds (from the SCStream PTS) of the main capture's first frame.
    private var firstMainFramePTS: Double?
    // Signalled when the file output confirms it finished writing.
    private let finishSem = DispatchSemaphore(value: 0)
    private var started = false
    private var didFinish = false

    /// Build the webcam recorder. Returns nil (with a `warn` event already
    /// emitted) if the device can't be found or the session can't be wired up —
    /// callers then proceed WITHOUT a webcam so the recording never breaks.
    init?(webcamURL: URL, uid: String) {
        self.webcamURL = webcamURL
        super.init()

        // Verify camera TCC authorization before touching AVCaptureSession at
        // all. The sidecar is a headless child process spawned by the app —
        // it can never itself trigger the system permission prompt (only
        // requestAccess from the app's own process can), so if the user
        // hasn't granted Camera access yet, building the session would just
        // silently fail later (no didStartRecordingTo, no file). Fail fast
        // here instead, with a truthful log, and degrade to no-webcam.
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
        let device = discovery.devices.first(where: { $0.uniqueID == uid })
            ?? AVCaptureDevice(uniqueID: uid)
            ?? discovery.devices.first
        guard let cam = device else {
            emit(["event": "warn", "kind": "camera_not_found",
                  "msg": "webcam device not found", "uid": uid])
            return nil
        }

        session.beginConfiguration()
        session.sessionPreset = .high

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

        // VIDEO ONLY — the mic is already captured in the main mix. We add no
        // audio input, so the webcam file has no audio track.
        guard session.canAddOutput(movieOutput) else {
            session.commitConfiguration()
            emit(["event": "warn", "kind": "camera_output", "msg": "cannot add webcam movie output to session"])
            return nil
        }
        session.addOutput(movieOutput)
        session.commitConfiguration()

        emit(["event": "webcam_ready", "device": cam.localizedName, "uid": cam.uniqueID])
    }

    private func nowHostSeconds() -> Double {
        CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock()))
    }

    /// Start the capture session and begin recording to the webcam file. Called
    /// BEFORE SCStream starts so the webcam is already rolling when the first
    /// main frame lands. Any failure degrades to a warn event.
    func start() {
        try? FileManager.default.removeItem(at: webcamURL)
        session.startRunning()
        // startRecording is safe to call once the session is running; the actual
        // file-start host time is captured in didStartRecordingTo.
        movieOutput.startRecording(to: webcamURL, recordingDelegate: self)
        stateLock.lock()
        started = true
        stateLock.unlock()
    }

    /// Record the main capture's first-frame PTS (host-clock seconds). Called
    /// once from the Recorder's stateQ on the first complete video frame.
    func markMainFirstFrame(ptsSeconds: Double) {
        stateLock.lock()
        if firstMainFramePTS == nil { firstMainFramePTS = ptsSeconds }
        stateLock.unlock()
    }

    // AVCaptureFileOutputRecordingDelegate
    func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL,
                    from connections: [AVCaptureConnection]) {
        let host = nowHostSeconds()
        stateLock.lock()
        if webcamStartHostSeconds == nil { webcamStartHostSeconds = host }
        stateLock.unlock()
        emit(["event": "webcam_recording", "path": fileURL.path])
    }

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL,
                    from connections: [AVCaptureConnection], error: Error?) {
        if let error = error {
            // AVCaptureFileOutput reports "recording stopped" style errors here
            // even on a clean stop; log it but don't treat it as fatal.
            emit(["event": "warn", "kind": "camera_finish",
                  "msg": "webcam finish reported error", "err": error.localizedDescription])
        }
        stateLock.lock()
        didFinish = true
        stateLock.unlock()
        finishSem.signal()
    }

    /// Stop the webcam cleanly and wait (bounded) for the file to finalize.
    /// Returns (path, offsetMs). `path` is "" when no usable file was produced;
    /// `offsetMs` is 0 when the timing couldn't be determined. Never hangs: the
    /// finish wait is capped at ~3s, after which we report the file anyway if it
    /// exists on disk.
    ///
    /// Callers may invoke this from any thread, including the sidecar's main
    /// queue (SIGTERM handler / `didStopWithError` both do). `stopRecording()`
    /// and the bounded `finishSem.wait()` run inside a `finalizeQ.async` block
    /// (never `.sync` — see the threading note atop this file for why `.sync`
    /// doesn't guarantee a thread hop). The caller here blocks on a separate
    /// `doneSem`, which is just a park-and-wait: it needs no thread of its own
    /// to make progress, so it's safe to block on from main.
    func finalize() -> (path: String, offsetMs: Int) {
        let wasStarted: Bool = {
            stateLock.lock(); defer { stateLock.unlock() }
            return started
        }()
        guard wasStarted else { return ("", 0) }

        let doneSem = DispatchSemaphore(value: 0)
        finalizeQ.async { [self] in
            if movieOutput.isRecording {
                movieOutput.stopRecording()
                // Bounded wait for didFinishRecordingTo. If it times out we
                // still report the file if it landed on disk. This wait
                // always executes on a finalizeQ worker thread (never the
                // original caller's thread — see the threading note above).
                _ = finishSem.wait(timeout: .now() + 3.0)
            }
            doneSem.signal()
        }
        // Bounded from this side too, defensively: finalizeQ's own wait is
        // already capped at 3s, so this should return almost immediately
        // after it does. The extra margin only guards against the
        // (never-observed) case of async dispatch itself stalling.
        _ = doneSem.wait(timeout: .now() + 4.0)
        session.stopRunning()

        let (startHost, mainPTS, finished): (Double?, Double?, Bool) = {
            stateLock.lock(); defer { stateLock.unlock() }
            return (webcamStartHostSeconds, firstMainFramePTS, didFinish)
        }()

        if !finished {
            emit(["event": "warn", "kind": "camera_finish_timeout",
                  "msg": "webcam did not confirm finish within 3s; reporting file if present"])
        }

        let fileExists = FileManager.default.fileExists(atPath: webcamURL.path)
        guard fileExists else {
            emit(["event": "warn", "kind": "camera_no_file", "msg": "webcam file not produced"])
            return ("", 0)
        }

        var offsetMs = 0
        if let startHost = startHost, let mainPTS = mainPTS {
            offsetMs = Int(((mainPTS - startHost) * 1000.0).rounded())
        } else {
            emit(["event": "warn", "kind": "camera_offset_unknown",
                  "msg": "webcam offset unknown (missing start or first-frame timestamp)",
                  "have_start": startHost != nil, "have_main_pts": mainPTS != nil])
        }
        emit(["event": "webcam_finalized", "path": webcamURL.path, "offset_ms": offsetMs])
        return (webcamURL.path, offsetMs)
    }
}
