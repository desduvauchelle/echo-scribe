import React, { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  listScreenSources,
  listInputDevices,
  listCameras,
  getScreenrecAudioPrefs,
  setScreenrecAudioPrefs,
  startScreenRecording,
  requestCameraAccess,
  openCameraSettings,
  type DisplaySource,
  type WindowSource,
  type InputDevice,
  type CameraSource,
} from "../lib/api";

type SourceKind = "screen" | "window";

const SetupWindow: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  // Source state
  const [sourceKind, setSourceKind] = useState<SourceKind>("screen");
  const [displays, setDisplays] = useState<DisplaySource[]>([]);
  const [windows, setWindows] = useState<WindowSource[]>([]);
  const [selectedDisplayId, setSelectedDisplayId] = useState<number | null>(null);
  const [selectedWindowId, setSelectedWindowId] = useState<number | null>(null);

  // Audio state
  const [sysaudio, setSysaudio] = useState(true);
  const [micEnabled, setMicEnabled] = useState(false);
  const [micDevice, setMicDevice] = useState("");
  const [inputDevices, setInputDevices] = useState<InputDevice[]>([]);

  // Cursor state: hide the system cursor during capture so the editor can draw
  // a synthetic (enlarged) cursor from the input-event track. Default OFF.
  const [hideCursor, setHideCursor] = useState(false);

  // Camera state: record a webcam alongside the capture. Enabled = a device
  // uid is selected (the persisted pref is the uid itself; "" = off). Camera
  // enumeration can fail independently (e.g. camera permission) without
  // breaking the rest of the setup window — the error renders inline and the
  // checkbox stays disabled.
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [cameraUid, setCameraUid] = useState("");
  const [cameras, setCameras] = useState<CameraSource[]>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Set when the in-app camera permission request comes back "denied". The
  // checkbox stays ON (recording still proceeds, just without the webcam —
  // the sidecar degrades gracefully) but we surface the same friendly nudge
  // the mic/accessibility flows use elsewhere in the app.
  const [cameraPermissionDenied, setCameraPermissionDenied] = useState(false);

  const [starting, setStarting] = useState(false);

  useEffect(() => {
    Promise.all([listScreenSources(), listInputDevices(), getScreenrecAudioPrefs()])
      .then(([sources, devices, prefs]) => {
        setDisplays(sources.displays);
        setWindows(sources.windows);
        if (sources.displays.length > 0) {
          setSelectedDisplayId(sources.displays[0].id);
        }
        if (sources.windows.length > 0) {
          setSelectedWindowId(sources.windows[0].id);
        }
        setInputDevices(devices);
        setSysaudio(prefs.sysaudio);
        setMicEnabled(prefs.mic_enabled);
        setHideCursor(prefs.hide_cursor);
        // Use saved mic device, or fall back to first available device
        const savedDevice = prefs.mic_device;
        if (savedDevice) {
          setMicDevice(savedDevice);
        } else if (devices.length > 0) {
          setMicDevice(devices[0].name);
        }
        // Saved camera uid = camera was on last time. The device select
        // falls back to the first listed camera if the saved one is gone.
        if (prefs.camera_uid) {
          setCameraEnabled(true);
          setCameraUid(prefs.camera_uid);
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));

    // Cameras load separately: a rejection (permission / helper failure) must
    // not take down the whole setup window. The rejection is already a
    // friendly message from the Rust side.
    listCameras()
      .then((c) => setCameras(c.cameras))
      .catch((e) => setCameraError(String(e)));
  }, []);

  const handleCancel = async () => {
    await getCurrentWindow().hide();
  };

  // The uid actually recorded with: only when the camera is enabled AND the
  // selected (or first available) device exists in the current list.
  const effectiveCameraUid = (() => {
    if (!cameraEnabled || cameras.length === 0) return "";
    if (cameras.some((c) => c.uid === cameraUid)) return cameraUid;
    return cameras[0].uid;
  })();

  const handleStart = async () => {
    setStartError(null);
    setStarting(true);
    try {
      // Persist audio + cursor + camera prefs ("" = camera off)
      await setScreenrecAudioPrefs({
        sysaudio,
        mic_enabled: micEnabled,
        mic_device: micDevice,
        hide_cursor: hideCursor,
        camera_uid: effectiveCameraUid,
      });

      // Build source label
      let sourceLabel = "";
      if (sourceKind === "screen") {
        const display = displays.find((d) => d.id === selectedDisplayId);
        sourceLabel = display?.label ?? "Screen";
      } else {
        const win = windows.find((w) => w.id === selectedWindowId);
        sourceLabel = win ? `${win.app} — ${win.title}` : "Window";
      }

      await startScreenRecording({
        display_id: sourceKind === "screen" ? selectedDisplayId : null,
        window_id: sourceKind === "window" ? selectedWindowId : null,
        mic_device: micEnabled && micDevice ? micDevice : null,
        sysaudio,
        source_label: sourceLabel,
        hide_cursor: hideCursor,
        camera_uid: effectiveCameraUid || null,
      });

      await getCurrentWindow().hide();
    } catch (e) {
      setStartError(String(e));
    } finally {
      setStarting(false);
    }
  };

  const isStartDisabled =
    starting ||
    (sourceKind === "window" && selectedWindowId === null);

  if (loading) {
    return (
      <div style={styles.root}>
        <p style={styles.loadingText}>Loading sources…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.root}>
        <p style={styles.errorText}>{error}</p>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <h2 style={styles.title}>New Recording</h2>
      </div>

      <div style={styles.body}>
        {/* Source kind segmented control */}
        <section style={styles.section}>
          <label style={styles.sectionLabel}>Capture</label>
          <div style={styles.segmentedControl}>
            <button
              style={{
                ...styles.segment,
                ...(sourceKind === "screen" ? styles.segmentActive : {}),
              }}
              onClick={() => setSourceKind("screen")}
            >
              Entire Screen
            </button>
            <button
              style={{
                ...styles.segment,
                ...(sourceKind === "window" ? styles.segmentActive : {}),
              }}
              onClick={() => setSourceKind("window")}
            >
              Window
            </button>
          </div>
        </section>

        {/* Display / Window picker */}
        <section style={styles.section}>
          {sourceKind === "screen" ? (
            <>
              <label style={styles.sectionLabel}>Display</label>
              {displays.length === 0 ? (
                <p style={styles.emptyText}>No displays found</p>
              ) : (
                <select
                  style={styles.select}
                  value={selectedDisplayId ?? ""}
                  onChange={(e) => setSelectedDisplayId(Number(e.target.value))}
                >
                  {displays.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
              )}
            </>
          ) : (
            <>
              <label style={styles.sectionLabel}>Window</label>
              {windows.length === 0 ? (
                <p style={styles.emptyText}>
                  No windows found. Screen Recording permission may be needed.
                </p>
              ) : (
                <div style={styles.windowList}>
                  {windows.map((w) => (
                    <button
                      key={w.id}
                      style={{
                        ...styles.windowRow,
                        ...(selectedWindowId === w.id
                          ? styles.windowRowSelected
                          : {}),
                      }}
                      onClick={() => setSelectedWindowId(w.id)}
                    >
                      {w.thumb ? (
                        <img
                          src={convertFileSrc(w.thumb)}
                          alt=""
                          style={styles.windowThumb}
                        />
                      ) : (
                        <div style={styles.windowThumbPlaceholder} />
                      )}
                      <div style={styles.windowMeta}>
                        <span style={styles.windowApp}>{w.app}</span>
                        <span style={styles.windowTitle}>{w.title}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        {/* Audio section */}
        <section style={styles.section}>
          <label style={styles.sectionLabel}>Audio</label>

          {/* System audio toggle */}
          <label style={styles.toggleRow}>
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={sysaudio}
              onChange={(e) => setSysaudio(e.target.checked)}
            />
            <span style={styles.toggleLabel}>System audio</span>
          </label>

          {/* Microphone toggle */}
          <label style={styles.toggleRow}>
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={micEnabled}
              onChange={(e) => setMicEnabled(e.target.checked)}
            />
            <span style={styles.toggleLabel}>Microphone</span>
          </label>

          {/* Mic device select (only when mic is enabled) */}
          {micEnabled && (
            <div style={styles.micSelectWrapper}>
              {inputDevices.length === 0 ? (
                <p style={styles.emptyText}>No input devices found</p>
              ) : (
                <select
                  style={styles.select}
                  value={micDevice}
                  onChange={(e) => setMicDevice(e.target.value)}
                >
                  {inputDevices.map((d) => (
                    <option key={d.name} value={d.name}>
                      {d.name}
                      {d.is_system_default ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </section>

        {/* Cursor section */}
        <section style={styles.section}>
          <label style={styles.sectionLabel}>Cursor</label>
          <label style={styles.toggleRow}>
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={hideCursor}
              onChange={(e) => setHideCursor(e.target.checked)}
            />
            <span style={styles.toggleLabel}>
              Enhance cursor in editor (hides the system cursor while recording)
            </span>
          </label>
          <p style={styles.hintText}>
            Records without the system cursor so the editor can draw a larger,
            stylized cursor with click effects.
          </p>
        </section>

        {/* Camera section */}
        <section style={styles.section}>
          <label style={styles.sectionLabel}>Camera</label>
          <label
            style={{
              ...styles.toggleRow,
              ...(cameraError || cameras.length === 0
                ? styles.toggleRowDisabled
                : {}),
            }}
          >
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={cameraEnabled}
              disabled={cameraError !== null || cameras.length === 0}
              onChange={(e) => {
                const checked = e.target.checked;
                setCameraEnabled(checked);
                // First enable with nothing selected: default to first camera.
                if (checked && !cameraUid && cameras.length > 0) {
                  setCameraUid(cameras[0].uid);
                }
                if (checked) {
                  // Trigger the in-app camera prompt (or read the cached
                  // decision). Recording still proceeds even on "denied" —
                  // the sidecar degrades to no-webcam — so this only ever
                  // shows a nudge, never blocks Start.
                  requestCameraAccess()
                    .then((outcome) => {
                      setCameraPermissionDenied(outcome === "denied");
                    })
                    .catch(() => {
                      // Non-fatal: leave the warning cleared and let the
                      // sidecar's own camera_denied log be the fallback
                      // signal if something's actually wrong.
                    });
                } else {
                  setCameraPermissionDenied(false);
                }
              }}
            />
            <span style={styles.toggleLabel}>
              Record webcam (shown as an overlay in the editor)
            </span>
          </label>

          {/* Friendly camera-listing error, inline like the sources error */}
          {cameraError && <p style={styles.errorText}>{cameraError}</p>}
          {!cameraError && cameras.length === 0 && (
            <p style={styles.emptyText}>No cameras found</p>
          )}

          {/* Camera permission denied: recording still proceeds without the
              webcam, so this is a nudge, not a blocker. */}
          {cameraEnabled && cameraPermissionDenied && (
            <div style={styles.errorText}>
              <p style={{ margin: 0 }}>
                Camera access is off for Echo Scribe. Open System Settings →
                Privacy &amp; Security → Camera, enable Echo Scribe, then quit
                and reopen.
              </p>
              <button
                style={styles.openSettingsButton}
                onClick={() => openCameraSettings()}
              >
                Open Settings
              </button>
            </div>
          )}

          {/* Camera device select (only when enabled) */}
          {cameraEnabled && !cameraError && cameras.length > 0 && (
            <div style={styles.micSelectWrapper}>
              <select
                style={styles.select}
                value={effectiveCameraUid}
                onChange={(e) => setCameraUid(e.target.value)}
              >
                {cameras.map((c) => (
                  <option key={c.uid} value={c.uid}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </section>

        {/* Inline error */}
        {startError && (
          <p style={styles.errorText}>{startError}</p>
        )}
      </div>

      {/* Footer buttons */}
      <div style={styles.footer}>
        <button style={styles.cancelButton} onClick={handleCancel}>
          Cancel
        </button>
        <button
          style={{
            ...styles.startButton,
            ...(isStartDisabled ? styles.startButtonDisabled : {}),
          }}
          onClick={handleStart}
          disabled={isStartDisabled}
        >
          {starting ? "Starting…" : "Start Recording"}
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Inline styles using design tokens from globals.css custom properties
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    backgroundColor: "var(--color-canvas)",
    color: "var(--color-fg)",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    WebkitFontSmoothing: "antialiased",
    overflow: "hidden",
  },
  header: {
    padding: "16px 20px 12px",
    borderBottom: "1px solid var(--color-line)",
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: "15px",
    fontWeight: 600,
    color: "var(--color-fg)",
    letterSpacing: "-0.011em",
  },
  body: {
    flex: 1,
    overflowY: "auto",
    padding: "4px 0",
  },
  section: {
    padding: "12px 20px",
    borderBottom: "1px solid var(--color-line)",
  },
  sectionLabel: {
    display: "block",
    fontSize: "11px",
    fontWeight: 600,
    color: "var(--color-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: "8px",
  },
  segmentedControl: {
    display: "flex",
    gap: "2px",
    backgroundColor: "var(--color-surface)",
    borderRadius: "8px",
    padding: "2px",
    border: "1px solid var(--color-line)",
  },
  segment: {
    flex: 1,
    padding: "5px 12px",
    border: "none",
    borderRadius: "6px",
    backgroundColor: "transparent",
    color: "var(--color-muted)",
    fontSize: "13px",
    fontWeight: 500,
    cursor: "pointer",
    transition: "background-color 150ms ease, color 150ms ease",
  },
  segmentActive: {
    backgroundColor: "var(--color-elevated)",
    color: "var(--color-fg)",
  },
  select: {
    width: "100%",
    padding: "7px 10px",
    backgroundColor: "var(--color-surface)",
    color: "var(--color-fg)",
    border: "1px solid var(--color-line)",
    borderRadius: "6px",
    fontSize: "13px",
    appearance: "auto" as React.CSSProperties["appearance"],
    cursor: "pointer",
    outline: "none",
  },
  windowList: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    maxHeight: "320px",
    overflowY: "auto",
    border: "1px solid var(--color-line)",
    borderRadius: "6px",
    backgroundColor: "var(--color-surface)",
    padding: "4px",
  },
  windowRow: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    width: "100%",
    appearance: "none",
    padding: "8px",
    textAlign: "left",
    backgroundColor: "transparent",
    border: "1px solid transparent",
    borderRadius: "6px",
    cursor: "pointer",
    color: "var(--color-fg)",
    fontSize: "13px",
    transition: "background-color 120ms ease",
    gap: "12px",
    overflow: "hidden",
  },
  windowRowSelected: {
    backgroundColor: "var(--color-accent-soft)",
    borderColor: "var(--color-accent)",
    color: "var(--color-accent)",
  },
  windowThumb: {
    width: "128px",
    height: "72px",
    objectFit: "cover" as React.CSSProperties["objectFit"],
    borderRadius: "6px",
    flexShrink: 0,
    backgroundColor: "var(--color-line)",
  },
  windowThumbPlaceholder: {
    width: "128px",
    height: "72px",
    borderRadius: "6px",
    flexShrink: 0,
    backgroundColor: "var(--color-line)",
  },
  windowMeta: {
    display: "flex",
    flexDirection: "column" as React.CSSProperties["flexDirection"],
    gap: "2px",
    overflow: "hidden",
    minWidth: 0,
  },
  windowApp: {
    fontWeight: 500,
    flexShrink: 0,
    whiteSpace: "nowrap" as React.CSSProperties["whiteSpace"],
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  windowTitle: {
    color: "var(--color-muted)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as React.CSSProperties["whiteSpace"],
    fontSize: "12px",
  },
  toggleRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "4px 0",
    cursor: "pointer",
    userSelect: "none",
    marginBottom: "4px",
  },
  toggleRowDisabled: {
    opacity: 0.45,
    cursor: "not-allowed",
  },
  checkbox: {
    accentColor: "var(--color-accent)",
    width: "14px",
    height: "14px",
    cursor: "pointer",
    flexShrink: 0,
  },
  toggleLabel: {
    fontSize: "13px",
    color: "var(--color-fg)",
  },
  micSelectWrapper: {
    marginTop: "6px",
    paddingLeft: "22px",
  },
  emptyText: {
    margin: 0,
    fontSize: "12px",
    color: "var(--color-muted)",
    fontStyle: "italic",
  },
  hintText: {
    margin: "2px 0 0 22px",
    fontSize: "11px",
    lineHeight: 1.4,
    color: "var(--color-muted)",
  },
  loadingText: {
    margin: "auto",
    fontSize: "13px",
    color: "var(--color-muted)",
    textAlign: "center",
  },
  errorText: {
    margin: "8px 20px",
    fontSize: "12px",
    color: "var(--color-danger)",
    backgroundColor: "rgba(248, 113, 113, 0.08)",
    padding: "8px 10px",
    borderRadius: "6px",
    border: "1px solid rgba(248, 113, 113, 0.2)",
  },
  openSettingsButton: {
    marginTop: "8px",
    padding: "5px 12px",
    backgroundColor: "var(--color-surface)",
    color: "var(--color-fg)",
    border: "1px solid var(--color-line)",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 500,
    cursor: "pointer",
  },
  footer: {
    display: "flex",
    gap: "8px",
    padding: "12px 20px",
    borderTop: "1px solid var(--color-line)",
    justifyContent: "flex-end",
    flexShrink: 0,
  },
  cancelButton: {
    padding: "7px 16px",
    backgroundColor: "var(--color-surface)",
    color: "var(--color-muted)",
    border: "1px solid var(--color-line)",
    borderRadius: "7px",
    fontSize: "13px",
    fontWeight: 500,
    cursor: "pointer",
    transition: "background-color 120ms ease, color 120ms ease",
  },
  startButton: {
    padding: "7px 16px",
    backgroundColor: "var(--color-accent)",
    color: "#080e0d",
    border: "none",
    borderRadius: "7px",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    transition: "background-color 120ms ease",
  },
  startButtonDisabled: {
    opacity: 0.45,
    cursor: "not-allowed",
  },
};

export default SetupWindow;
