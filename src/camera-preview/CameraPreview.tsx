import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { logCameraPreviewError } from "../lib/api";

type StartPayload = { camera_name?: string };

/**
 * Floating self-view: a small mirrored webcam preview shown while a screen
 * recording with the camera enabled is running.
 *
 * The sidecar records the camera by AVFoundation `uniqueID`. WebKit's
 * getUserMedia `deviceId` is a per-origin salted hash that does NOT equal that
 * `uniqueID`, so we bridge the two by LABEL: `MediaDeviceInfo.label` matches
 * `AVCaptureDevice.localizedName`, which is exactly the `name` the Rust side
 * passes in the `camera-preview-start` payload. This is fragile — duplicate
 * labels or a WebKit-side localization difference can pick the wrong device —
 * but a mismatch only changes which camera the *preview* shows; the recording
 * still uses the correct device. When no label matches we fall back to the
 * default video input rather than showing nothing.
 */
const CameraPreview: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Monotonic token so a late-arriving getUserMedia from a previous start can't
  // clobber the stream of a newer start (or a stop that happened in between).
  const startTokenRef = useRef(0);
  // The camera name the LIVE stream was started for — lets a repeated
  // `camera-preview-start` for the same camera keep the running stream instead
  // of cycling the device (the pre-warm flow shows the preview during setup,
  // then `start_screen_recording` shows it again at capture start; reopening
  // there powered the camera off/on right as the recorder attached).
  const activeCameraRef = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const stopStream = () => {
    startTokenRef.current += 1; // invalidate any in-flight start
    activeCameraRef.current = undefined;
    const s = streamRef.current;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const startStream = async (cameraName: string | undefined) => {
    // Idempotent: same camera already live → keep the stream, never cycle the
    // device. (A live stream with a DIFFERENT camera falls through to the
    // teardown + reopen below.)
    if (
      streamRef.current &&
      activeCameraRef.current === cameraName &&
      streamRef.current.getVideoTracks().some((t) => t.readyState === "live")
    ) {
      return;
    }
    // Tear down any existing stream first so we never hold two.
    stopStream();
    const token = startTokenRef.current;
    setError(null);
    try {
      // Resolve the requested camera by LABEL before opening anything: if a
      // prior grant already populated device labels, we open the right device
      // directly — a single acquisition, no LED off/on cycle. Only a fresh
      // origin (empty labels) needs the probe stream below.
      const findByLabel = async () => {
        if (!cameraName) return undefined;
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.find((d) => d.kind === "videoinput" && d.label === cameraName);
      };

      let stream: MediaStream;
      const direct = await findByLabel();
      if (direct?.deviceId) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: direct.deviceId } },
        });
      } else {
        // Labels not populated yet (or no name requested): open the default
        // camera. This grant populates labels; wry auto-grants the WKWebView
        // permission, so it never blocks on a prompt.
        stream = await navigator.mediaDevices.getUserMedia({ video: true });

        // If a specific camera was requested and the probe stream is NOT
        // already that device, switch — opening the matched device BEFORE
        // stopping the probe so the pipeline never fully releases the camera
        // mid-swap. When the probe already IS the target (single-camera setups,
        // target == default), keep it: zero extra opens.
        if (cameraName && stream.getVideoTracks()[0]?.label !== cameraName) {
          const match = await findByLabel();
          if (match?.deviceId) {
            const preferred = await navigator.mediaDevices.getUserMedia({
              video: { deviceId: { exact: match.deviceId } },
            });
            stream.getTracks().forEach((t) => t.stop());
            stream = preferred;
          } else {
            // Label matching is best-effort (AVFoundation localizedName vs
            // MediaDeviceInfo.label). Preview-only: the recording still uses
            // the camera the user picked.
            console.warn(
              `[camera-preview] no device label matched "${cameraName}"; showing default camera`,
            );
          }
        }
      }

      // A stop (or a newer start) landed while we were awaiting — discard.
      if (token !== startTokenRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;
      activeCameraRef.current = cameraName;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // Defensive: muted + playsInline should autoplay, but call play()
        // explicitly so a stricter policy still yields a live preview.
        videoRef.current.play().catch(() => {});
      }
    } catch (e) {
      if (token === startTokenRef.current) {
        setError("Camera preview unavailable");
        // Log the raw reason for diagnostics; the UI stays a short friendly
        // message. The backend bridge lands the error name (NotAllowedError
        // vs NotReadableError etc.) in the daily log, where the webview
        // console can't be seen in a production bundle.
        console.error("[camera-preview] getUserMedia failed:", e);
        const detail =
          e instanceof DOMException ? `${e.name}: ${e.message}` : String(e);
        void logCameraPreviewError(detail).catch(() => {});
      }
    }
  };

  useEffect(() => {
    let unlistenStart: (() => void) | undefined;
    let unlistenStop: (() => void) | undefined;

    (async () => {
      unlistenStart = await listen<StartPayload>("camera-preview-start", (event) => {
        void startStream(event.payload?.camera_name);
      });
      unlistenStop = await listen("camera-preview-stop", () => {
        stopStream();
      });
    })();

    return () => {
      unlistenStart?.();
      unlistenStop?.();
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={styles.root} data-tauri-drag-region>
      <video
        ref={videoRef}
        style={styles.video}
        autoPlay
        muted
        playsInline
        aria-label="Camera preview"
        data-tauri-drag-region
      />
      {error && <div style={styles.error}>{error}</div>}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  root: {
    width: "100%",
    height: "100%",
    borderRadius: 14,
    overflow: "hidden",
    background: "#000",
    boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
    position: "relative",
    cursor: "grab",
  },
  video: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    // Mirror the preview so it reads like a mirror (matches every other
    // self-view UX). The recorded file is NOT mirrored — this is preview-only.
    transform: "scaleX(-1)",
    pointerEvents: "none",
  },
  error: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "rgba(255,255,255,0.85)",
    font: "12px -apple-system, system-ui, sans-serif",
    textAlign: "center",
    padding: "0 12px",
    pointerEvents: "none",
  },
};

export default CameraPreview;
