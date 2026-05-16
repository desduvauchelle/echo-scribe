use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;
use tracing::warn;

#[derive(Debug, Clone, Serialize)]
pub struct InputDevice {
    pub name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub is_system_default: bool,
}

pub fn list_input_devices() -> Vec<InputDevice> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|d| d.name().ok());

    let devices = match host.input_devices() {
        Ok(it) => it,
        Err(e) => {
            warn!(?e, "failed to enumerate input devices");
            return Vec::new();
        }
    };

    let mut out = Vec::new();
    for d in devices {
        let name = match d.name() {
            Ok(n) => n,
            Err(e) => {
                warn!(?e, "skipping input device with unreadable name");
                continue;
            }
        };
        let cfg = d.default_input_config().ok();
        let (sample_rate, channels) = cfg
            .map(|c| (c.sample_rate().0, c.channels()))
            .unwrap_or((0, 0));
        let is_system_default = default_name.as_ref().is_some_and(|n| n == &name);
        out.push(InputDevice {
            name,
            sample_rate,
            channels,
            is_system_default,
        });
    }
    out
}
