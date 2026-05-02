use std::sync::Arc;

use rdev::Key;
use tauri::AppHandle;
use tauri_plugin_store::{Store, StoreExt};
use thiserror::Error;
use tracing::warn;

use crate::input::binding::Binding;

const STORE_FILENAME: &str = "settings.json";
const KEY_VOICE_AT_CURSOR_BINDING: &str = "voice_at_cursor_binding";
const KEY_LOG_CAPTURE_BINDING: &str = "log_capture_binding";
const KEY_SPEECH_MODEL_ID: &str = "speech_model_id";
const KEY_LLM_MODEL_ID: &str = "llm_model_id";

/// Errors raised by [`SettingsStore`].
#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("failed to access store: {0}")]
    Store(String),
    #[error("failed to (de)serialize settings value: {0}")]
    Serde(#[from] serde_json::Error),
}

/// Wrapper around the tauri-plugin-store handle for our app's settings.
///
/// All settings live in a single JSON file (`settings.json`) located in the
/// per-app data dir managed by tauri-plugin-store.
pub struct SettingsStore {
    store: Arc<Store<tauri::Wry>>,
}

impl SettingsStore {
    /// Open (or create) the settings store.
    pub fn load(app: &AppHandle) -> Result<Self, SettingsError> {
        let store = app
            .store(STORE_FILENAME)
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(Self { store })
    }

    /// Returns the configured voice-at-cursor binding, or the default
    /// (`Binding::single(Key::ControlRight)`) if none is stored or the stored
    /// value can't be deserialized.
    pub fn voice_at_cursor_binding(&self) -> Binding {
        match self.store.get(KEY_VOICE_AT_CURSOR_BINDING) {
            Some(value) => match serde_json::from_value::<Binding>(value) {
                Ok(b) => b,
                Err(e) => {
                    warn!(?e, "stored voice_at_cursor_binding is invalid; falling back to default");
                    default_binding()
                }
            },
            None => default_binding(),
        }
    }

    /// Persist the voice-at-cursor binding.
    pub fn set_voice_at_cursor_binding(&self, b: Binding) -> Result<(), SettingsError> {
        let value = serde_json::to_value(&b)?;
        self.store.set(KEY_VOICE_AT_CURSOR_BINDING, value);
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Returns the persisted active speech model id, or `None` if no model has
    /// been chosen yet (first run).
    pub fn speech_model_id(&self) -> Option<String> {
        self.store.get(KEY_SPEECH_MODEL_ID).and_then(|v| {
            v.as_str().map(|s| s.to_string()).or_else(|| {
                serde_json::from_value::<String>(v).ok()
            })
        })
    }

    /// Persist the active speech model id.
    pub fn set_speech_model_id(&self, id: &str) -> Result<(), SettingsError> {
        self.store
            .set(KEY_SPEECH_MODEL_ID, serde_json::Value::String(id.to_string()));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Returns the persisted active LLM model id, or `None` if no model has
    /// been chosen yet.
    pub fn llm_model_id(&self) -> Option<String> {
        self.store.get(KEY_LLM_MODEL_ID).and_then(|v| {
            v.as_str()
                .map(|s| s.to_string())
                .or_else(|| serde_json::from_value::<String>(v).ok())
        })
    }

    /// Persist the active LLM model id.
    pub fn set_llm_model_id(&self, id: &str) -> Result<(), SettingsError> {
        self.store
            .set(KEY_LLM_MODEL_ID, serde_json::Value::String(id.to_string()));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Returns the configured log-capture binding, or the default
    /// (`Binding::single(Key::AltGr)`) if none is stored or invalid.
    pub fn log_capture_binding(&self) -> Binding {
        match self.store.get(KEY_LOG_CAPTURE_BINDING) {
            Some(value) => match serde_json::from_value::<Binding>(value) {
                Ok(b) => b,
                Err(e) => {
                    warn!(?e, "stored log_capture_binding is invalid; falling back to default");
                    default_log_capture_binding()
                }
            },
            None => default_log_capture_binding(),
        }
    }

    /// Persist the log-capture binding.
    pub fn set_log_capture_binding(&self, b: Binding) -> Result<(), SettingsError> {
        let value = serde_json::to_value(&b)?;
        self.store.set(KEY_LOG_CAPTURE_BINDING, value);
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }
}

/// The default voice-at-cursor binding used when nothing is stored.
pub fn default_binding() -> Binding {
    Binding::single(Key::ControlRight)
}

/// The default log-capture binding used when nothing is stored.
/// Per the Phase 0 design: right Option (AltGr).
pub fn default_log_capture_binding() -> Binding {
    Binding::single(Key::AltGr)
}
