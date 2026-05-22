use std::sync::Arc;

use rdev::Key;
use tauri::AppHandle;
use tauri_plugin_store::{Store, StoreExt};
use thiserror::Error;
use tracing::warn;

use crate::input::binding::{Binding, ModifierKind, ModifierSide, SerKey};

const STORE_FILENAME: &str = "settings.json";
const KEY_VOICE_AT_CURSOR_BINDING: &str = "voice_at_cursor_binding";
const KEY_LOG_CAPTURE_BINDING: &str = "log_capture_binding";
const KEY_ACTION_BINDING: &str = "action_binding";
const KEY_TRIGGER_WORD_ROUTING_ENABLED: &str = "trigger_word_routing_enabled";
const KEY_ACTION_TRIGGER_WORD: &str = "action_trigger_word";
const KEY_SPEECH_MODEL_ID: &str = "speech_model_id";
const KEY_LLM_MODEL_ID: &str = "llm_model_id";
const KEY_AUDIO_FEEDBACK_ENABLED: &str = "audio_feedback_enabled";
const KEY_MUTE_WHILE_RECORDING: &str = "mute_while_recording";
const KEY_ONBOARDING_COMPLETED: &str = "onboarding_completed";
const KEY_FILLER_REMOVAL_ENABLED: &str = "filler_removal_enabled";
const KEY_FILLER_WORDS: &str = "filler_words";
const KEY_CUSTOM_WORDS: &str = "custom_words";
const KEY_LLM_UNLOAD_SECS: &str = "llm_unload_secs";
const KEY_ASR_UNLOAD_SECS: &str = "asr_unload_secs";
const KEY_LAST_UPDATE_CHECK: &str = "last_update_check";
const KEY_DISMISSED_UPDATE_VERSION: &str = "dismissed_update_version";
const KEY_AUTO_FILE_ENABLED: &str = "auto_file_enabled";
const KEY_AUTO_FILE_THRESHOLD: &str = "auto_file_threshold";
const KEY_MEETING_AUTO_DETECT: &str = "meeting_auto_detect";
const KEY_MEETING_APP_PREFS: &str = "meeting_app_prefs";
const KEY_MEETING_SOFT_WARN_MIN: &str = "meeting_soft_warn_minutes";
const KEY_MEETING_HARD_CAP_MIN: &str = "meeting_hard_cap_minutes";
const KEY_PREFERRED_INPUT_DEVICE: &str = "preferred_input_device";
const KEY_RECENT_INPUT_DEVICES: &str = "recent_input_devices";
const KEY_INPUT_DEVICE_SORT: &str = "input_device_sort";
const KEY_DAILY_RECAP_ENABLED: &str = "daily_recap_enabled";
const KEY_DAILY_RECAP_DELIVER_HOUR: &str = "daily_recap_deliver_hour";
const KEY_DAILY_RECAP_INCLUDE_WEEKENDS: &str = "daily_recap_include_weekends";
const KEY_GUIDE_OVERLAY_MODE: &str = "guide_overlay_mode";
const KEY_GUIDE_OVERLAY_FRAME: &str = "guide_overlay_frame";
const KEY_APP_LAUNCHER_ENABLED: &str = "app_launcher_enabled";
const KEY_ACTION_COUNTER: &str = "action_counter";
const KEY_MEETING_SUMMARY_PROMPT: &str = "meeting_summary_prompt";
const KEY_SCREENREC_SYSAUDIO: &str = "screenrec_sysaudio";
const KEY_SCREENREC_MIC_ENABLED: &str = "screenrec_mic_enabled";
const KEY_SCREENREC_MIC_DEVICE: &str = "screenrec_mic_device";

pub const DEFAULT_MEETING_SUMMARY_PROMPT: &str = "You are an expert meeting note-taker. You receive a transcript of a {duration_minutes}-minute conversation captured from {app}. The transcript labels each segment as 'You:' (the user) or 'Them:' (the other side).";

/// Default: morning recap notification is on.
pub const DEFAULT_DAILY_RECAP_ENABLED: bool = true;
/// Default: deliver at 08:00 local time. Range 0–23.
pub const DEFAULT_DAILY_RECAP_DELIVER_HOUR: u8 = 8;
/// Default: skip weekends.
pub const DEFAULT_DAILY_RECAP_INCLUDE_WEEKENDS: bool = false;

/// Cap on how many entries we keep in the recent-input-devices MRU list.
/// Picks beyond this fall off the end.
const RECENT_INPUT_DEVICES_CAP: usize = 10;

/// Sort order for the input-device picker. Defaults to [`InputDeviceSort::LastUsed`].
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InputDeviceSort {
    /// System default first, then preferred, then by recency, then alphabetical.
    LastUsed,
    /// System default first, then preferred, then strictly alphabetical.
    Alphabetical,
}

impl Default for InputDeviceSort {
    fn default() -> Self {
        InputDeviceSort::LastUsed
    }
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MeetingAppPref {
    Always,
    Ask,
    Never,
}

/// Default: unload the LLM engine after 2 minutes of idle. `0` means never unload.
pub const DEFAULT_LLM_UNLOAD_SECS: u64 = 120;

/// Default: unload the ASR engine after 2 minutes of idle. `0` means never unload.
pub const DEFAULT_ASR_UNLOAD_SECS: u64 = 120;

/// Default threshold above which a high-confidence classification is auto-filed
/// without showing the review overlay.
pub const DEFAULT_AUTO_FILE_THRESHOLD: f32 = 0.75;

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
#[derive(Clone)]
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

    /// Returns the configured action hotkey binding, or the default
    /// combo Option+A if none is stored or invalid.
    pub fn action_binding(&self) -> Binding {
        match self.store.get(KEY_ACTION_BINDING) {
            Some(value) => match serde_json::from_value::<Binding>(value) {
                Ok(b) => b,
                Err(e) => {
                    warn!(?e, "stored action_binding is invalid; falling back to default");
                    default_action_binding()
                }
            },
            None => default_action_binding(),
        }
    }

    /// Persist the action hotkey binding.
    pub fn set_action_binding(&self, b: Binding) -> Result<(), SettingsError> {
        let value = serde_json::to_value(&b)?;
        self.store.set(KEY_ACTION_BINDING, value);
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Getter for whether prefix trigger routing is enabled (default: true)
    pub fn trigger_word_routing_enabled(&self) -> bool {
        self.store
            .get(KEY_TRIGGER_WORD_ROUTING_ENABLED)
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    /// Setter for whether prefix trigger routing is enabled
    pub fn set_trigger_word_routing_enabled(&self, on: bool) -> Result<(), SettingsError> {
        self.store
            .set(KEY_TRIGGER_WORD_ROUTING_ENABLED, serde_json::Value::Bool(on));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Getter for the action trigger word prefix (default: "echo")
    pub fn action_trigger_word(&self) -> String {
        self.store
            .get(KEY_ACTION_TRIGGER_WORD)
            .and_then(|v| {
                v.as_str()
                    .map(|s| s.to_string())
                    .or_else(|| serde_json::from_value::<String>(v).ok())
            })
            .unwrap_or_else(|| "echo".to_string())
    }

    /// Setter for the action trigger word prefix
    pub fn set_action_trigger_word(&self, word: &str) -> Result<(), SettingsError> {
        self.store
            .set(KEY_ACTION_TRIGGER_WORD, serde_json::Value::String(word.trim().to_lowercase()));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Whether audio feedback (start/stop/ready blips) is enabled. Defaults
    /// to `true` for new installs, and is preserved across restarts via the
    /// settings store.
    pub fn audio_feedback_enabled(&self) -> bool {
        self.store
            .get(KEY_AUDIO_FEEDBACK_ENABLED)
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    /// Persist the audio-feedback toggle.
    pub fn set_audio_feedback_enabled(&self, on: bool) -> Result<(), SettingsError> {
        self.store
            .set(KEY_AUDIO_FEEDBACK_ENABLED, serde_json::Value::Bool(on));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Whether system audio should be muted while recording. Defaults to `false`.
    pub fn mute_while_recording(&self) -> bool {
        self.store
            .get(KEY_MUTE_WHILE_RECORDING)
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    pub fn set_mute_while_recording(&self, on: bool) -> Result<(), SettingsError> {
        self.store
            .set(KEY_MUTE_WHILE_RECORDING, serde_json::Value::Bool(on));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Whether the user has completed the onboarding flow at least once.
    /// Defaults to `false` — the App.tsx routing layer uses this flag (not a
    /// permissions inference) to decide whether to show Onboarding vs Main.
    ///
    /// Note: existing pre-Phase-6 users will see Onboarding once on upgrade
    /// since this flag will be missing from their settings store. That's a
    /// deliberate choice — it lets them pick an LLM model now that the step
    /// exists, and re-confirms permissions cheaply.
    pub fn onboarding_completed(&self) -> bool {
        self.store
            .get(KEY_ONBOARDING_COMPLETED)
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    /// Mark onboarding as complete (called when the user taps Start).
    pub fn set_onboarding_completed(&self, on: bool) -> Result<(), SettingsError> {
        self.store
            .set(KEY_ONBOARDING_COMPLETED, serde_json::Value::Bool(on));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Whether filler-word removal runs on every transcript. Defaults to true.
    pub fn filler_removal_enabled(&self) -> bool {
        self.store
            .get(KEY_FILLER_REMOVAL_ENABLED)
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    pub fn set_filler_removal_enabled(&self, on: bool) -> Result<(), SettingsError> {
        self.store
            .set(KEY_FILLER_REMOVAL_ENABLED, serde_json::Value::Bool(on));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// User-customizable list of filler words. Falls back to the built-in
    /// `DEFAULT_FILLERS` list when nothing is stored.
    pub fn filler_words(&self) -> Vec<String> {
        self.store
            .get(KEY_FILLER_WORDS)
            .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
            .unwrap_or_else(|| {
                crate::asr::postprocess::DEFAULT_FILLERS
                    .iter()
                    .map(|s| s.to_string())
                    .collect()
            })
    }

    pub fn set_filler_words(&self, words: Vec<String>) -> Result<(), SettingsError> {
        let value = serde_json::to_value(&words)?;
        self.store.set(KEY_FILLER_WORDS, value);
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// User-supplied custom dictionary used to fix proper-noun spellings
    /// produced by the ASR ("Antoine", "Amandine", project names, etc.).
    pub fn custom_words(&self) -> Vec<String> {
        self.store
            .get(KEY_CUSTOM_WORDS)
            .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
            .unwrap_or_default()
    }

    pub fn set_custom_words(&self, words: Vec<String>) -> Result<(), SettingsError> {
        let value = serde_json::to_value(&words)?;
        self.store.set(KEY_CUSTOM_WORDS, value);
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// How many seconds the LLM engine stays loaded after its last use before
    /// being automatically evicted from RAM. `0` means never evict. Defaults
    /// to [`DEFAULT_LLM_UNLOAD_SECS`] (2 minutes).
    pub fn llm_unload_secs(&self) -> u64 {
        self.store
            .get(KEY_LLM_UNLOAD_SECS)
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_LLM_UNLOAD_SECS)
    }

    pub fn set_llm_unload_secs(&self, secs: u64) -> Result<(), SettingsError> {
        self.store.set(
            KEY_LLM_UNLOAD_SECS,
            serde_json::Value::Number(secs.into()),
        );
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// How many seconds the ASR (speech-to-text) engine stays loaded after its
    /// last use before being automatically evicted from RAM. `0` means never
    /// evict. Defaults to [`DEFAULT_ASR_UNLOAD_SECS`] (2 minutes).
    pub fn asr_unload_secs(&self) -> u64 {
        self.store
            .get(KEY_ASR_UNLOAD_SECS)
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_ASR_UNLOAD_SECS)
    }

    pub fn set_asr_unload_secs(&self, secs: u64) -> Result<(), SettingsError> {
        self.store.set(
            KEY_ASR_UNLOAD_SECS,
            serde_json::Value::Number(secs.into()),
        );
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Unix timestamp (seconds) of the last update check. Defaults to 0 (never checked).
    pub fn last_update_check(&self) -> i64 {
        self.store
            .get(KEY_LAST_UPDATE_CHECK)
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
    }

    pub fn set_last_update_check(&self, ts: i64) -> Result<(), SettingsError> {
        self.store
            .set(KEY_LAST_UPDATE_CHECK, serde_json::Value::Number(ts.into()));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Version string the user last dismissed (e.g. `"0.2.0"`). `None` if never dismissed.
    pub fn dismissed_update_version(&self) -> Option<String> {
        self.store
            .get(KEY_DISMISSED_UPDATE_VERSION)
            .and_then(|v| v.as_str().map(|s| s.to_string()))
    }

    pub fn set_dismissed_update_version(&self, version: &str) -> Result<(), SettingsError> {
        self.store.set(
            KEY_DISMISSED_UPDATE_VERSION,
            serde_json::Value::String(version.to_string()),
        );
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Whether log captures with `confidence >= threshold` are filed silently
    /// (with a toast / notification) instead of opening the review overlay.
    /// Defaults to `true`. New-project proposals always open the overlay
    /// regardless of this flag.
    pub fn auto_file_enabled(&self) -> bool {
        self.store
            .get(KEY_AUTO_FILE_ENABLED)
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    pub fn set_auto_file_enabled(&self, on: bool) -> Result<(), SettingsError> {
        self.store
            .set(KEY_AUTO_FILE_ENABLED, serde_json::Value::Bool(on));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Threshold (0.0–1.0) for auto-filing. Defaults to
    /// [`DEFAULT_AUTO_FILE_THRESHOLD`]. Out-of-range stored values are clamped.
    pub fn auto_file_threshold(&self) -> f32 {
        let raw = self
            .store
            .get(KEY_AUTO_FILE_THRESHOLD)
            .and_then(|v| v.as_f64())
            .map(|f| f as f32)
            .unwrap_or(DEFAULT_AUTO_FILE_THRESHOLD);
        raw.clamp(0.0, 1.0)
    }

    pub fn set_auto_file_threshold(&self, t: f32) -> Result<(), SettingsError> {
        let clamped = t.clamp(0.0, 1.0) as f64;
        self.store.set(
            KEY_AUTO_FILE_THRESHOLD,
            serde_json::Value::from(clamped),
        );
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    pub fn meeting_auto_detect(&self) -> bool {
        self.store
            .get(KEY_MEETING_AUTO_DETECT)
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    pub fn set_meeting_auto_detect(&self, on: bool) -> Result<(), SettingsError> {
        self.store
            .set(KEY_MEETING_AUTO_DETECT, serde_json::Value::Bool(on));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    pub fn meeting_app_prefs(&self) -> std::collections::HashMap<String, MeetingAppPref> {
        self.store
            .get(KEY_MEETING_APP_PREFS)
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    pub fn set_meeting_app_prefs(
        &self,
        prefs: &std::collections::HashMap<String, MeetingAppPref>,
    ) -> Result<(), SettingsError> {
        let value = serde_json::to_value(prefs)?;
        self.store.set(KEY_MEETING_APP_PREFS, value);
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    pub fn meeting_soft_warn_min(&self) -> u32 {
        self.store
            .get(KEY_MEETING_SOFT_WARN_MIN)
            .and_then(|v| v.as_u64())
            .map(|n| n as u32)
            .unwrap_or(120)
    }

    pub fn set_meeting_soft_warn_min(&self, n: u32) -> Result<(), SettingsError> {
        self.store
            .set(KEY_MEETING_SOFT_WARN_MIN, serde_json::Value::Number(n.into()));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    pub fn meeting_hard_cap_min(&self) -> u32 {
        self.store
            .get(KEY_MEETING_HARD_CAP_MIN)
            .and_then(|v| v.as_u64())
            .map(|n| n as u32)
            .unwrap_or(240)
    }

    pub fn set_meeting_hard_cap_min(&self, n: u32) -> Result<(), SettingsError> {
        self.store
            .set(KEY_MEETING_HARD_CAP_MIN, serde_json::Value::Number(n.into()));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Name of the user's preferred input device, or `None` for "use system default."
    /// When set, the recorder hard-fails (no silent fallback) if the named device
    /// is unavailable — see [`crate::audio::recorder::RecorderError::PreferredDeviceMissing`].
    pub fn preferred_input_device(&self) -> Option<String> {
        self.store
            .get(KEY_PREFERRED_INPUT_DEVICE)
            .and_then(|v| v.as_str().map(|s| s.to_string()))
    }

    /// Persist the preferred input device. Pass `None` to clear (revert to system default).
    /// Side effect: when `Some(name)`, also bumps `name` to the front of the MRU list.
    pub fn set_preferred_input_device(&self, name: Option<&str>) -> Result<(), SettingsError> {
        match name {
            Some(n) => {
                self.store.set(
                    KEY_PREFERRED_INPUT_DEVICE,
                    serde_json::Value::String(n.to_string()),
                );
                self.bump_recent_input_device_inner(n)?;
            }
            None => {
                self.store.delete(KEY_PREFERRED_INPUT_DEVICE);
            }
        }
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// MRU list of recently selected input devices, most recent first.
    pub fn recent_input_devices(&self) -> Vec<String> {
        self.store
            .get(KEY_RECENT_INPUT_DEVICES)
            .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
            .unwrap_or_default()
    }

    /// Push a device to the front of the MRU list. Dedupes (case-sensitive
    /// match), caps the list at [`RECENT_INPUT_DEVICES_CAP`], saves on success.
    pub fn bump_recent_input_device(&self, name: &str) -> Result<(), SettingsError> {
        self.bump_recent_input_device_inner(name)?;
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Internal helper: mutates the MRU without saving, so callers can batch
    /// multiple updates into one `save()`.
    fn bump_recent_input_device_inner(&self, name: &str) -> Result<(), SettingsError> {
        let mut list = self.recent_input_devices();
        list.retain(|n| n != name);
        list.insert(0, name.to_string());
        list.truncate(RECENT_INPUT_DEVICES_CAP);
        let value = serde_json::to_value(&list)?;
        self.store.set(KEY_RECENT_INPUT_DEVICES, value);
        Ok(())
    }

    /// User's preferred sort order for the input-device picker.
    pub fn input_device_sort(&self) -> InputDeviceSort {
        self.store
            .get(KEY_INPUT_DEVICE_SORT)
            .and_then(|v| serde_json::from_value::<InputDeviceSort>(v).ok())
            .unwrap_or_default()
    }

    pub fn set_input_device_sort(&self, sort: InputDeviceSort) -> Result<(), SettingsError> {
        let value = serde_json::to_value(sort)?;
        self.store.set(KEY_INPUT_DEVICE_SORT, value);
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Whether the daily-recap notification fires each morning. Default: on.
    pub fn daily_recap_enabled(&self) -> bool {
        self.store
            .get(KEY_DAILY_RECAP_ENABLED)
            .and_then(|v| v.as_bool())
            .unwrap_or(DEFAULT_DAILY_RECAP_ENABLED)
    }

    pub fn set_daily_recap_enabled(&self, on: bool) -> Result<(), SettingsError> {
        self.store
            .set(KEY_DAILY_RECAP_ENABLED, serde_json::Value::Bool(on));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Hour of day (0–23, local time) at which the daily recap notification
    /// fires. Default 8.
    pub fn daily_recap_deliver_hour(&self) -> u8 {
        self.store
            .get(KEY_DAILY_RECAP_DELIVER_HOUR)
            .and_then(|v| v.as_u64())
            .and_then(|n| if n < 24 { Some(n as u8) } else { None })
            .unwrap_or(DEFAULT_DAILY_RECAP_DELIVER_HOUR)
    }

    pub fn set_daily_recap_deliver_hour(&self, hour: u8) -> Result<(), SettingsError> {
        let clamped = hour.min(23);
        self.store.set(
            KEY_DAILY_RECAP_DELIVER_HOUR,
            serde_json::Value::Number(serde_json::Number::from(clamped as u64)),
        );
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Whether the daily recap fires on Saturday and Sunday. Default: off.
    pub fn daily_recap_include_weekends(&self) -> bool {
        self.store
            .get(KEY_DAILY_RECAP_INCLUDE_WEEKENDS)
            .and_then(|v| v.as_bool())
            .unwrap_or(DEFAULT_DAILY_RECAP_INCLUDE_WEEKENDS)
    }

    pub fn set_daily_recap_include_weekends(&self, on: bool) -> Result<(), SettingsError> {
        self.store
            .set(KEY_DAILY_RECAP_INCLUDE_WEEKENDS, serde_json::Value::Bool(on));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    pub fn guide_overlay_mode(&self) -> Option<crate::meeting::guidance::Mode> {
        let v = self.store.get(KEY_GUIDE_OVERLAY_MODE)?;
        let s = v.as_str()?;
        crate::meeting::guidance::Mode::parse(s)
    }

    pub fn set_guide_overlay_mode(
        &self,
        mode: crate::meeting::guidance::Mode,
    ) -> Result<(), SettingsError> {
        let v = match mode {
            crate::meeting::guidance::Mode::Auto => "auto",
            crate::meeting::guidance::Mode::OnDemand => "on_demand",
        };
        self.store
            .set(KEY_GUIDE_OVERLAY_MODE, serde_json::Value::String(v.into()));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// HUD frame {x, y, width, height, collapsed}. Free-form JSON: the
    /// overlay reads/writes its own keys; backend just persists the blob.
    pub fn guide_overlay_frame(&self) -> Option<serde_json::Value> {
        self.store.get(KEY_GUIDE_OVERLAY_FRAME)
    }

    pub fn set_guide_overlay_frame(&self, v: serde_json::Value) -> Result<(), SettingsError> {
        self.store.set(KEY_GUIDE_OVERLAY_FRAME, v);
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    pub fn app_launcher_enabled(&self) -> bool {
        self.store
            .get(KEY_APP_LAUNCHER_ENABLED)
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    pub fn set_app_launcher_enabled(&self, on: bool) -> Result<(), SettingsError> {
        self.store
            .set(KEY_APP_LAUNCHER_ENABLED, serde_json::Value::Bool(on));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    pub fn action_counter(&self) -> u32 {
        self.store
            .get(KEY_ACTION_COUNTER)
            .and_then(|v| v.as_u64())
            .map(|n| n as u32)
            .unwrap_or(0)
    }

    pub fn set_action_counter(&self, count: u32) -> Result<(), SettingsError> {
        self.store
            .set(KEY_ACTION_COUNTER, serde_json::Value::Number(count.into()));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    pub fn increment_action_counter(&self) -> Result<u32, SettingsError> {
        let current = self.action_counter();
        let next = current + 1;
        self.set_action_counter(next)?;
        Ok(next)
    }

    pub fn meeting_summary_prompt(&self) -> String {
        self.store
            .get(KEY_MEETING_SUMMARY_PROMPT)
            .and_then(|v| {
                v.as_str()
                    .map(|s| s.to_string())
                    .or_else(|| serde_json::from_value::<String>(v).ok())
            })
            .unwrap_or_else(|| DEFAULT_MEETING_SUMMARY_PROMPT.to_string())
    }

    pub fn set_meeting_summary_prompt(&self, prompt: &str) -> Result<(), SettingsError> {
        self.store
            .set(KEY_MEETING_SUMMARY_PROMPT, serde_json::Value::String(prompt.to_string()));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Whether system audio capture is enabled for screen recordings. Defaults to `true`.
    pub fn screenrec_sysaudio(&self) -> bool {
        self.store
            .get(KEY_SCREENREC_SYSAUDIO)
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    pub fn set_screenrec_sysaudio(&self, on: bool) -> Result<(), SettingsError> {
        self.store
            .set(KEY_SCREENREC_SYSAUDIO, serde_json::Value::Bool(on));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// Whether microphone capture is enabled for screen recordings. Defaults to `false`.
    pub fn screenrec_mic_enabled(&self) -> bool {
        self.store
            .get(KEY_SCREENREC_MIC_ENABLED)
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }

    pub fn set_screenrec_mic_enabled(&self, on: bool) -> Result<(), SettingsError> {
        self.store
            .set(KEY_SCREENREC_MIC_ENABLED, serde_json::Value::Bool(on));
        self.store
            .save()
            .map_err(|e| SettingsError::Store(e.to_string()))?;
        Ok(())
    }

    /// The last-used microphone device name for screen recordings. Empty string means "system default".
    pub fn screenrec_mic_device(&self) -> String {
        self.store
            .get(KEY_SCREENREC_MIC_DEVICE)
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default()
    }

    pub fn set_screenrec_mic_device(&self, device: String) -> Result<(), SettingsError> {
        self.store
            .set(KEY_SCREENREC_MIC_DEVICE, serde_json::Value::String(device));
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

/// The default dedicated action binding: Alt + KeyA
pub fn default_action_binding() -> Binding {
    Binding {
        primary: SerKey(Key::KeyA),
        modifiers: vec![(ModifierKind::Alt, ModifierSide::Either)],
    }
}

#[cfg(test)]
mod updater_tests {
    use super::*;

    #[test]
    fn last_update_check_constant_is_correct() {
        assert_eq!(KEY_LAST_UPDATE_CHECK, "last_update_check");
    }

    #[test]
    fn dismissed_update_version_constant_is_correct() {
        assert_eq!(KEY_DISMISSED_UPDATE_VERSION, "dismissed_update_version");
    }
}

#[cfg(test)]
mod auto_file_tests {
    use super::*;

    #[test]
    fn auto_file_constants_are_correct() {
        assert_eq!(KEY_AUTO_FILE_ENABLED, "auto_file_enabled");
        assert_eq!(KEY_AUTO_FILE_THRESHOLD, "auto_file_threshold");
        assert!((DEFAULT_AUTO_FILE_THRESHOLD - 0.75).abs() < f32::EPSILON);
    }

    #[test]
    fn daily_recap_defaults() {
        assert!(DEFAULT_DAILY_RECAP_ENABLED);
        assert_eq!(DEFAULT_DAILY_RECAP_DELIVER_HOUR, 8);
        assert!(!DEFAULT_DAILY_RECAP_INCLUDE_WEEKENDS);
        assert_eq!(KEY_DAILY_RECAP_ENABLED, "daily_recap_enabled");
        assert_eq!(KEY_DAILY_RECAP_DELIVER_HOUR, "daily_recap_deliver_hour");
        assert_eq!(KEY_DAILY_RECAP_INCLUDE_WEEKENDS, "daily_recap_include_weekends");
    }

    #[test]
    fn app_launcher_constants_are_correct() {
        assert_eq!(KEY_APP_LAUNCHER_ENABLED, "app_launcher_enabled");
        assert_eq!(KEY_ACTION_COUNTER, "action_counter");
    }
}
