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
  const [error, setError] = useState<string | null>(null);

  const stopStream = () => {
    startTokenRef.current += 1; // invalidate any in-flight start
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
    // Tear down any existing stream first so we never hold two.
    stopStream();
    const token = startTokenRef.current;
    setError(null);
    try {
      // Kick a bare getUserMedia first: on a fresh origin, device labels are
      // empty until the page has been granted camera access at least once, so
      // enumerateDevices() would return unlabeled entries and defeat the
      // name→label match. This initial grant populates the labels. wry
      // auto-grants the WKWebView permission, so this never blocks on a prompt.
      let stream = await navigator.mediaDevices.getUserMedia({ video: true });

      // Now try to switch to the specific camera by matching its label.
      if (cameraName) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const match = devices.find(
          (d) => d.kind === "videoinput" && d.label === cameraName,
        );
        if (match && match.deviceId) {
          const preferred = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: match.deviceId } },
          });
          // Swap: stop the temporary default-camera stream, keep the matched one.
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

      // A stop (or a newer start) landed while we were awaiting — discard.
      if (token !== startTokenRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;
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
