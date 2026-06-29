use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Capabilities {
    pub direct_voice_capture: bool,
    pub local_database: bool,
    pub meeting_auto_detect: bool,
    pub system_audio_capture: bool,
    pub calendar_matching: bool,
    pub screen_recording: bool,
    pub bundle_self_update: bool,
}

impl Capabilities {
    pub fn current() -> Self {
        Self::for_os(std::env::consts::OS)
    }

    pub fn for_os(os: &str) -> Self {
        let macos = os == "macos";
        Self {
            direct_voice_capture: macos,
            local_database: true,
            meeting_auto_detect: macos,
            system_audio_capture: macos,
            calendar_matching: macos,
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
        assert!(caps.calendar_matching);
        assert!(caps.screen_recording);
        assert!(caps.bundle_self_update);
    }

    #[test]
    fn windows_capabilities_disable_macos_sidecar_features() {
        let caps = Capabilities::for_os("windows");
        assert!(!caps.meeting_auto_detect);
        assert!(!caps.system_audio_capture);
        assert!(!caps.calendar_matching);
        assert!(!caps.screen_recording);
        assert!(!caps.bundle_self_update);
        assert!(!caps.direct_voice_capture);
        assert!(caps.local_database);
    }
}
