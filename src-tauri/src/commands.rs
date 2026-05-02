//! Tauri commands exposed to the frontend.
//!
//! These wire up:
//!  - permission status checks + deep links into System Settings
//!  - get/update of the user-configurable voice-at-cursor binding
//!  - explicit pipeline start (called by onboarding once permissions are green)
//!
//! The [`AppState`] container is created in [`crate::lib::run`] and managed via
//! Tauri's state container (`app.manage(...)`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, Wry};
use tokio::sync::mpsc;
use tokio::sync::mpsc::UnboundedSender;
use tracing::{error, info};

use crate::coordinator::{self, new_state_handle, PipelineState};
use crate::input::binding::{code_from_key, key_from_code, Binding, ModifierKind, ModifierSide, SerKey};
use crate::input::hotkeys::{spawn_listener, HotkeyEvent};
use crate::permissions::{self, MicAccessOutcome, PermissionsStatus, SettingsPane};
use crate::settings::SettingsStore;
use crate::ui::tray::TrayHandle;

/// Application-wide state shared by all Tauri commands.
///
/// `tray` is held behind an `Arc<Mutex<_>>` because tray updates fire from
/// the coordinator thread. `binding` is an `Arc<RwLock<_>>` so the rdev
/// listener thread can re-read it on every event without us having to tear
/// the listener down to change the hotkey.
pub struct AppState {
    pub tray: Arc<Mutex<TrayHandle<Wry>>>,
    pub settings: SettingsStore,
    pub binding: Arc<RwLock<Binding>>,
    pub hotkey_started: AtomicBool,
    pub hotkey_tx: Mutex<Option<UnboundedSender<HotkeyEvent>>>,
}

/// JSON-friendly mirror of [`Binding`].
///
/// `primary` is the DOM `KeyboardEvent.code` string (e.g. `"ControlRight"`).
/// We translate it to/from `rdev::Key` via [`key_from_code`] and [`code_from_key`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsBinding {
    pub primary: String,
    pub modifiers: Vec<JsModifier>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsModifier {
    /// "Control" | "Shift" | "Alt" | "Meta"
    pub kind: String,
    /// "Left" | "Right" | "Either"
    pub side: String,
}

#[derive(Debug, thiserror::Error)]
pub enum BindingConversionError {
    #[error("unknown key code: {0}")]
    UnknownKey(String),
    #[error("unknown modifier kind: {0}")]
    UnknownModifierKind(String),
    #[error("unknown modifier side: {0}")]
    UnknownModifierSide(String),
}

impl TryFrom<JsBinding> for Binding {
    type Error = BindingConversionError;

    fn try_from(js: JsBinding) -> Result<Self, Self::Error> {
        let primary = key_from_code(&js.primary)
            .ok_or_else(|| BindingConversionError::UnknownKey(js.primary.clone()))?;
        let mut modifiers = Vec::with_capacity(js.modifiers.len());
        for m in js.modifiers {
            let kind = match m.kind.as_str() {
                "Control" => ModifierKind::Control,
                "Shift" => ModifierKind::Shift,
                "Alt" => ModifierKind::Alt,
                "Meta" => ModifierKind::Meta,
                other => {
                    return Err(BindingConversionError::UnknownModifierKind(other.to_string()))
                }
            };
            let side = match m.side.as_str() {
                "Left" => ModifierSide::Left,
                "Right" => ModifierSide::Right,
                "Either" => ModifierSide::Either,
                other => {
                    return Err(BindingConversionError::UnknownModifierSide(other.to_string()))
                }
            };
            modifiers.push((kind, side));
        }
        Ok(Binding {
            primary: SerKey(primary),
            modifiers,
        })
    }
}

impl From<Binding> for JsBinding {
    fn from(b: Binding) -> Self {
        let primary = code_from_key(b.primary.0).unwrap_or("Unknown").to_string();
        let modifiers = b
            .modifiers
            .into_iter()
            .map(|(kind, side)| JsModifier {
                kind: match kind {
                    ModifierKind::Control => "Control",
                    ModifierKind::Shift => "Shift",
                    ModifierKind::Alt => "Alt",
                    ModifierKind::Meta => "Meta",
                }
                .to_string(),
                side: match side {
                    ModifierSide::Left => "Left",
                    ModifierSide::Right => "Right",
                    ModifierSide::Either => "Either",
                }
                .to_string(),
            })
            .collect();
        JsBinding { primary, modifiers }
    }
}

// ----- Tauri commands -----

#[tauri::command]
pub fn permissions_status() -> PermissionsStatus {
    permissions::status()
}

#[tauri::command]
pub fn open_microphone_settings() -> Result<(), String> {
    permissions::open_settings(SettingsPane::Microphone).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_accessibility_settings() -> Result<(), String> {
    permissions::open_settings(SettingsPane::Accessibility).map_err(|e| e.to_string())
}

/// Trigger the macOS in-process microphone prompt (or return the cached
/// decision). Returns `true` if access is granted (now or already), `false`
/// if denied or undetermined.
#[tauri::command]
pub async fn request_microphone_access() -> Result<bool, String> {
    Ok(matches!(
        permissions::request_microphone().await,
        MicAccessOutcome::Granted
    ))
}

/// Trigger the macOS Accessibility prompt. The dialog is a side effect; the
/// returned bool is the current trust state (typically `false` on first
/// call — the user still has to flip the toggle in System Settings).
#[tauri::command]
pub fn prompt_accessibility_access() -> Result<bool, String> {
    Ok(permissions::prompt_accessibility())
}

#[tauri::command]
pub fn get_voice_at_cursor_binding(state: State<'_, AppState>) -> JsBinding {
    let b = state
        .binding
        .read()
        .map(|g| g.clone())
        .unwrap_or_else(|_| crate::settings::default_binding());
    b.into()
}

#[tauri::command]
pub fn update_voice_at_cursor_binding(
    state: State<'_, AppState>,
    binding: JsBinding,
) -> Result<(), String> {
    let parsed: Binding = binding.try_into().map_err(|e: BindingConversionError| e.to_string())?;
    state
        .settings
        .set_voice_at_cursor_binding(parsed.clone())
        .map_err(|e| e.to_string())?;
    let mut guard = state
        .binding
        .write()
        .map_err(|_| "binding lock poisoned".to_string())?;
    *guard = parsed;
    Ok(())
}

#[tauri::command]
pub fn start_pipeline(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    ensure_pipeline_started(&state, &app);
    Ok(())
}

#[tauri::command]
pub fn is_pipeline_running(state: State<'_, AppState>) -> bool {
    state.hotkey_started.load(Ordering::SeqCst)
}

/// Idempotently start the rdev listener + coordinator pipeline.
///
/// On first call, creates the hotkey channel, spawns the rdev listener with
/// the shared `Arc<RwLock<Binding>>`, and spawns the coordinator on its own
/// dedicated thread + LocalSet (the coordinator owns a `!Send` `cpal::Stream`).
///
/// On subsequent calls, returns early. Callers can also poll
/// [`is_pipeline_running`] / `state.hotkey_started`.
pub fn ensure_pipeline_started(state: &AppState, _app: &AppHandle) {
    if state.hotkey_started.swap(true, Ordering::SeqCst) {
        // Already started.
        return;
    }

    info!("starting voice-at-cursor pipeline");

    let (hotkey_tx, hotkey_rx) = mpsc::unbounded_channel::<HotkeyEvent>();

    // Stash the tx so the rest of the app could conceivably push events
    // synthetically (e.g. a "test transcription" button later).
    if let Ok(mut slot) = state.hotkey_tx.lock() {
        *slot = Some(hotkey_tx.clone());
    }

    spawn_listener(Arc::clone(&state.binding), hotkey_tx);

    let pipeline_state = new_state_handle();
    let tray_for_state = Arc::clone(&state.tray);

    thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                error!(?e, "failed to build coordinator runtime");
                return;
            }
        };
        let local = tokio::task::LocalSet::new();
        local.spawn_local(async move {
            coordinator::spawn(hotkey_rx, pipeline_state, move |new_state: PipelineState| {
                if let Ok(t) = tray_for_state.lock() {
                    t.set_state(new_state);
                }
            });
        });
        rt.block_on(local);
    });
}

/// Convenience wrapper used by `lib.rs::run`'s setup hook to look up the
/// managed `AppState` and start the pipeline if permissions allow.
pub fn ensure_pipeline_started_from_handle(app: &AppHandle) {
    let state: State<'_, AppState> = app.state();
    ensure_pipeline_started(&state, app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use rdev::Key;

    #[test]
    fn key_from_code_handles_known_and_unknown_codes() {
        assert_eq!(key_from_code("ControlRight"), Some(Key::ControlRight));
        assert_eq!(key_from_code("KeyA"), Some(Key::KeyA));
        assert_eq!(key_from_code("Digit0"), Some(Key::Num0));
        assert_eq!(key_from_code("F12"), Some(Key::F12));
        assert_eq!(key_from_code("AltLeft"), Some(Key::Alt));
        assert_eq!(key_from_code("AltRight"), Some(Key::AltGr));
        assert_eq!(key_from_code("Enter"), Some(Key::Return));
        // Unknown codes return None.
        assert_eq!(key_from_code(""), None);
        assert_eq!(key_from_code("NotARealCode"), None);
        assert_eq!(key_from_code("F30"), None);
    }

    #[test]
    fn js_binding_round_trips_through_binding() {
        // single-key
        let single = Binding::single(Key::ControlRight);
        let js: JsBinding = single.clone().into();
        assert_eq!(js.primary, "ControlRight");
        assert!(js.modifiers.is_empty());
        let back: Binding = js.try_into().expect("should convert back");
        assert_eq!(back, single);

        // combo with modifier
        let combo = Binding {
            primary: SerKey(Key::KeyL),
            modifiers: vec![(ModifierKind::Meta, ModifierSide::Right)],
        };
        let js: JsBinding = combo.clone().into();
        assert_eq!(js.primary, "KeyL");
        assert_eq!(js.modifiers.len(), 1);
        assert_eq!(js.modifiers[0].kind, "Meta");
        assert_eq!(js.modifiers[0].side, "Right");
        let back: Binding = js.try_into().expect("should convert back");
        assert_eq!(back, combo);
    }

    #[test]
    fn js_binding_rejects_unknown_key() {
        let js = JsBinding {
            primary: "BogusCode".to_string(),
            modifiers: vec![],
        };
        let err = Binding::try_from(js).unwrap_err();
        assert!(matches!(err, BindingConversionError::UnknownKey(_)));
    }
}
