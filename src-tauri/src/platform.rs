use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Capabilities {
    pub direct_voice_capture: bool,
    pub local_database: bool,
    pub meeting_auto_detect: bool,
    pub system_audio_capture: bool,
    pub screen_recording: bool,
    pub bundle_self_update: bool,
}

impl Capabilities {
    pub fn current() -> Self {
        Self::for_os(std::env::consts::OS)
    }

    pub fn for_os(os: &str) -> Self {
        let macos = os == "macos";
        let windows = os == "windows";
        Self {
            // Dictation loop works on macOS and Windows (cpal mic, Parakeet
            // ASR, arboard+enigo paste). Other platforms stay off until proven.
            direct_voice_capture: macos || windows,
            local_database: true,
            meeting_auto_detect: macos,
            system_audio_capture: macos,
            screen_recording: macos,
            bundle_self_update: macos,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_capabilities_enable_sidecar_features() {
        let caps = Capabilities::for_os("macos");
        assert!(caps.meeting_auto_detect);
        assert!(caps.system_audio_capture);
        assert!(caps.screen_recording);
        assert!(caps.bundle_self_update);
    }

    #[test]
    fn windows_capabilities_disable_macos_sidecar_features() {
        let caps = Capabilities::for_os("windows");
        // Sidecar-backed features remain off on Windows.
        assert!(!caps.meeting_auto_detect);
        assert!(!caps.system_audio_capture);
        assert!(!caps.screen_recording);
        assert!(!caps.bundle_self_update);
        // Core dictation loop is enabled on Windows (cpal + Parakeet + paste).
        assert!(caps.direct_voice_capture);
        assert!(caps.local_database);
    }

    #[test]
    fn non_macos_never_enables_sidecar_loops() {
        for os in ["windows", "linux"] {
            let caps = Capabilities::for_os(os);
            assert!(!caps.meeting_auto_detect, "{os} must not auto-detect meetings");
            assert!(!caps.screen_recording, "{os} must not screen record");
            assert!(!caps.system_audio_capture, "{os} must not capture system audio");
        }
    }
}
