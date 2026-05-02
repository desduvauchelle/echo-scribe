use std::sync::{Arc, Mutex};
use std::thread;

use rdev::{listen, Event, EventType, Key};
use tokio::sync::mpsc;
use tracing::{error, info};

use super::binding::Binding;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyEvent {
    /// The bound action's binding became fully satisfied (transition from not-satisfied to satisfied).
    Pressed,
    /// The binding stopped being satisfied (any required key released).
    Released,
}

/// Spawns a background thread that listens to global keyboard events and
/// emits HotkeyEvent::Pressed / Released on the given channel whenever the
/// given binding's satisfaction state changes.
///
/// `rdev::listen` blocks the calling thread, so this must run on a dedicated thread.
pub fn spawn_listener(binding: Binding, tx: mpsc::UnboundedSender<HotkeyEvent>) {
    thread::spawn(move || {
        let pressed: Arc<Mutex<Vec<Key>>> = Arc::new(Mutex::new(Vec::new()));
        let satisfied = Arc::new(Mutex::new(false));

        let pressed_for_cb = Arc::clone(&pressed);
        let satisfied_for_cb = Arc::clone(&satisfied);
        let binding = binding.clone();

        info!(?binding, "starting hotkey listener");

        let result = listen(move |event: Event| {
            let mut pressed = match pressed_for_cb.lock() {
                Ok(p) => p,
                Err(_) => return,
            };
            match event.event_type {
                EventType::KeyPress(k) => {
                    if !pressed.contains(&k) {
                        pressed.push(k);
                    }
                }
                EventType::KeyRelease(k) => {
                    pressed.retain(|p| *p != k);
                }
                _ => return,
            }
            let now_satisfied = binding.is_satisfied_by(&pressed);
            let mut sat = match satisfied_for_cb.lock() {
                Ok(s) => s,
                Err(_) => return,
            };
            if now_satisfied && !*sat {
                *sat = true;
                let _ = tx.send(HotkeyEvent::Pressed);
            } else if !now_satisfied && *sat {
                *sat = false;
                let _ = tx.send(HotkeyEvent::Released);
            }
        });

        if let Err(e) = result {
            error!(?e, "rdev listener exited unexpectedly");
        }
    });
}
