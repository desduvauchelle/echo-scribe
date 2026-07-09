import React, { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  listScreenSources,
  listInputDevices,
  listCameras,
  getScreenrecAudioPrefs,
  setScreenrecAudioPrefs,
  startScreenRecording,
  requestCameraAccess,
  openCameraSettings,
  showAreaPicker,
  closeAreaPicker,
  showCountdownOverlay,
  hideCountdownOverlay,
  type DisplaySource,
  type WindowSource,
  type InputDevice,
  type CameraSource,
  type AreaPickerResultPayload,
} from "../lib/api";

type SourceKind = "screen" | "window" | "area";

/** The countdown page (src/countdown/Countdown.tsx) is the single owner of
 *  the countdown's duration — it drives its own visual tick and tells us
 *  when it's done via the `countdown-finished` event. This window no
 *  longer runs a parallel timer of its own (that duplicated clock was an
 *  Esc-cancel race: a late Esc could lose to this window's timer firing
 *  first and start recording anyway). */
const COUNTDOWN_SECONDS = 3;

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

  // Area state ("area" source kind): the picker runs on `selectedDisplayId`
  // (the same display dropdown "screen" uses) and reports back a GLOBAL
  // points rect via the `area-picker-result` event. `null` = no selection
  // yet (Start is disabled until one exists).
  const [areaRect, setAreaRect] = useState<[number, number, number, number] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

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

  // Countdown state: 3s pre-record tick, persisted with the other prefs.
  // Default OFF.
  const [countdownEnabled, setCountdownEnabled] = useState(false);

  const [starting, setStarting] = useState(false);
  // Resolver for the in-flight countdown wait promise (see handleStart).
  // Either the `countdown-finished` listener (cancelled=false) or the
  // `countdown-cancelled` listener (cancelled=true) calls this exactly
  // once per countdown run to wake the await in handleStart. `null` once
  // resolved so a stray/duplicate/late event of the OTHER kind is a no-op
  // — this is the cancel-wins guard: whichever of finished/cancelled
  // arrives FIRST wins, and the second one (if it somehow still arrives)
  // can never re-resolve or double-fire recording start.
  const countdownResolveRef = useRef<((cancelled: boolean) => void) | null>(null);

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
        setCountdownEnabled(prefs.countdown);
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

  // Area picker result + countdown finish/cancel listeners. All three are
  // long-lived for the setup window's whole mounted lifetime (not tied to
  // sourceKind/pickerOpen) so a result that arrives after a re-render still
  // lands correctly.
  useEffect(() => {
    let unlistenPicker: (() => void) | undefined;
    let unlistenCountdownCancel: (() => void) | undefined;
    let unlistenCountdownFinish: (() => void) | undefined;

    (async () => {
      unlistenPicker = await listen<AreaPickerResultPayload>(
        "area-picker-result",
        (event) => {
          setPickerOpen(false);
          const rect = event.payload?.rect ?? null;
          if (rect) {
            setAreaRect(rect);
          }
          // A cancelled/no-op picker keeps whatever rect (if any) was
          // already selected — cancelling a re-select must not clear a
          // previously-confirmed area.
        },
      );
      unlistenCountdownCancel = await listen("countdown-cancelled", () => {
        // The Rust side already re-shows this window. Cancel wins: wake
        // the awaited promise with cancelled=true and clear the resolver
        // so a `countdown-finished` that was already in flight (e.g. the
        // countdown page's tick and the Esc keydown landed in the same
        // ~tick) is a no-op when it arrives — see the resolver's own
        // null-check below and in the finished listener.
        if (countdownResolveRef.current === null) return;
        countdownResolveRef.current(true);
        countdownResolveRef.current = null;
        setStarting(false);
      });
      unlistenCountdownFinish = await listen("countdown-finished", () => {
        // The countdown page is the single clock; this fires when its
        // visual tick reaches zero. If cancel already resolved this run's
        // promise (resolver is null), a late finish must be a no-op —
        // cancel wins, recording must not start after Esc.
        if (countdownResolveRef.current === null) return;
        countdownResolveRef.current(false);
        countdownResolveRef.current = null;
      });
    })();

    return () => {
      unlistenPicker?.();
      unlistenCountdownCancel?.();
      unlistenCountdownFinish?.();
    };
  }, []);

  const handleCancel = async () => {
    // Never strand the picker overlay if the user dismisses setup while a
    // pick is in progress.
    if (pickerOpen) {
      await closeAreaPicker();
      setPickerOpen(false);
    }
    await getCurrentWindow().hide();
  };

  const handleSelectArea = async () => {
    if (selectedDisplayId === null) return;
    setStartError(null);
    setPickerOpen(true);
    try {
      await showAreaPicker(selectedDisplayId);
    } catch (e) {
      setPickerOpen(false);
      setStartError(String(e));
    }
  };

  // The uid actually recorded with: only when the camera is enabled AND the
  // selected (or first available) device exists in the current list.
  const effectiveCameraUid = (() => {
    if (!cameraEnabled || cameras.length === 0) return "";
    if (cameras.some((c) => c.uid === cameraUid)) return cameraUid;
    return cameras[0].uid;
  })();

  // Actually invokes startScreenRecording with the currently-selected
  // params. Shared by the immediate-start path and the post-countdown path
  // so the two can never drift (same source label / rect / audio / camera
  // logic either way). Throws on failure — callers decide how to surface it.
  const doStartRecording = async () => {
    let sourceLabel = "";
    if (sourceKind === "screen") {
      const display = displays.find((d) => d.id === selectedDisplayId);
      sourceLabel = display?.label ?? "Screen";
    } else if (sourceKind === "window") {
      const win = windows.find((w) => w.id === selectedWindowId);
      sourceLabel = win ? `${win.app} — ${win.title}` : "Window";
    } else {
      const display = displays.find((d) => d.id === selectedDisplayId);
      sourceLabel = display ? `Area of ${display.label}` : "Area";
    }

    await startScreenRecording({
      // The area picker always runs on a specific display, so an "area"
      // recording is still a display-path capture (with a crop rect) —
      // window_id stays null.
      display_id: sourceKind !== "window" ? selectedDisplayId : null,
      window_id: sourceKind === "window" ? selectedWindowId : null,
      mic_device: micEnabled && micDevice ? micDevice : null,
      sysaudio,
      source_label: sourceLabel,
      hide_cursor: hideCursor,
      camera_uid: effectiveCameraUid || null,
      rect: sourceKind === "area" ? areaRect : null,
    });
  };

  const handleStart = async () => {
    setStartError(null);
    setStarting(true);
    try {
      // Persist audio + cursor + camera + countdown prefs ("" = camera off)
      await setScreenrecAudioPrefs({
        sysaudio,
        mic_enabled: micEnabled,
        mic_device: micDevice,
        hide_cursor: hideCursor,
        camera_uid: effectiveCameraUid,
        countdown: countdownEnabled,
      });

      if (!countdownEnabled) {
        await doStartRecording();
        await getCurrentWindow().hide();
        setStarting(false);
        return;
      }

      // Countdown path: hide setup, show the countdown overlay on the
      // target display, wait for it to finish, then start recording
      // unchanged. `selectedDisplayId` is the target display in every
      // sourceKind — "window" has no display to center on, so the
      // countdown falls back to the primary display's bounds via a
      // 0-fallback id only if no display list is available at all (should
      // not normally happen since displays are always enumerated).
      const countdownDisplayId =
        (sourceKind === "window" ? displays[0]?.id : selectedDisplayId) ??
        displays[0]?.id ??
        null;
      if (countdownDisplayId === null) {
        // No display to center on — degrade to immediate start rather than
        // failing the recording outright.
        await doStartRecording();
        await getCurrentWindow().hide();
        setStarting(false);
        return;
      }

      await getCurrentWindow().hide();
      await showCountdownOverlay(countdownDisplayId, COUNTDOWN_SECONDS);

      // Wait for the countdown page to tell us it's done. The countdown
      // page is the single clock for the countdown's duration — it emits
      // `countdown-finished` when its own visual tick reaches zero, and
      // that's the ONLY thing that resolves this promise with
      // `cancelled: false`. This window does not run a timer of its own
      // (previously a parallel `setTimeout` here raced Esc-cancel: a late
      // Esc could lose to this timer and start recording anyway). The
      // `countdown-cancelled` listener resolves the same promise with
      // `cancelled: true` (see the listener effect above); whichever event
      // arrives first wins and clears the resolver, so the other one (if
      // it still arrives) is a no-op.
      const cancelled = await new Promise<boolean>((resolve) => {
        countdownResolveRef.current = resolve;
      });
      if (cancelled) {
        // countdown-cancelled already reset `starting` and re-showed setup;
        // nothing left to do here.
        return;
      }

      await hideCountdownOverlay();
      await doStartRecording();
      setStarting(false);
    } catch (e) {
      // Recording-start failure on the countdown path: the setup window is
      // currently hidden (we hid it before/after the countdown), so bring
      // it back so the user can see the error and retry — mirrors the
      // immediate-start path where the window never left the foreground.
      await hideCountdownOverlay();
      setStartError(String(e));
      setStarting(false);
      await getCurrentWindow().show();
      await getCurrentWindow().setFocus();
    }
  };

  const isStartDisabled =
    starting ||
    (sourceKind === "window" && selectedWindowId === null) ||
    (sourceKind === "area" && areaRect === null);

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
            <button
              style={{
                ...styles.segment,
                ...(sourceKind === "area" ? styles.segmentActive : {}),
              }}
              onClick={() => setSourceKind("area")}
            >
              Area
            </button>
          </div>
        </section>

        {/* Display / Window / Area picker */}
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
          ) : sourceKind === "window" ? (
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
          ) : (
            <>
              <label style={styles.sectionLabel}>Display</label>
              {displays.length === 0 ? (
                <p style={styles.emptyText}>No displays found</p>
              ) : (
                <select
                  style={styles.select}
                  value={selectedDisplayId ?? ""}
                  onChange={(e) => {
                    setSelectedDisplayId(Number(e.target.value));
                    // A picked rect is only meaningful for the display it
                    // was picked on — switching displays invalidates it.
                    setAreaRect(null);
                  }}
                >
                  {displays.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
              )}

              <div style={styles.areaPickerRow}>
                <button
                  style={styles.selectAreaButton}
                  onClick={handleSelectArea}
                  disabled={selectedDisplayId === null || pickerOpen}
                >
                  {pickerOpen
                    ? "Selecting…"
                    : areaRect
                      ? "Re-select area"
                      : "Select area"}
                </button>
                {areaRect && (
                  <span style={styles.areaRectReadout}>
                    {Math.round(areaRect[2])}×{Math.round(areaRect[3])}
                  </span>
                )}
              </div>
              {!areaRect && !pickerOpen && (
                <p style={styles.hintText}>
                  Drag to select the region to record.
                </p>
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

        {/* Countdown section */}
        <section style={styles.section}>
          <label style={styles.sectionLabel}>Countdown</label>
          <label style={styles.toggleRow}>
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={countdownEnabled}
              onChange={(e) => setCountdownEnabled(e.target.checked)}
            />
            <span style={styles.toggleLabel}>
              Show a 3-second countdown before recording starts
            </span>
          </label>
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
                    .catch((e) => {
                      // Non-fatal: leave the warning cleared and let the
                      // sidecar's own camera_denied log be the fallback
                      // signal if something's actually wrong.
                      console.error("[setup] requestCameraAccess failed:", e);
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
  areaPickerRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginTop: "8px",
  },
  selectAreaButton: {
    padding: "7px 14px",
    backgroundColor: "var(--color-surface)",
    color: "var(--color-fg)",
    border: "1px solid var(--color-line)",
    borderRadius: "7px",
    fontSize: "13px",
    fontWeight: 500,
    cursor: "pointer",
  },
  areaRectReadout: {
    fontSize: "12px",
    color: "var(--color-muted)",
    fontVariantNumeric: "tabular-nums",
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
