//! Global hotkey listener.
//!
//! On macOS this is a `CGEventTap` (HID-level) that can SWALLOW key events
//! matching the bound hotkey so they don't leak through to the focused app
//! (e.g. Right-Cmd alone won't accidentally trigger menus). On non-macOS
//! targets we ship a no-op stub so the lib still compiles cross-platform —
//! Echo Scribe is macOS-only at runtime, but cross-compilation hygiene matters
//! for `cargo check`/CI.
//!
//! The public surface is:
//!
//! - [`HotkeyEvent`] — `Pressed` / `Released` transitions of the bound binding.
//! - [`spawn_listener`] — start the platform listener on a dedicated thread.
//!
//! Implementation notes (macOS):
//!
//! 1. We watch `KeyDown`, `KeyUp`, and `FlagsChanged` (modifier-only press/
//!    release).
//! 2. The CG keycode is translated to `rdev::Key` via
//!    [`cg_keycode_to_rdev_key`] so the rest of the codebase stays on the same
//!    `Binding` model that the settings UI talks to.
//! 3. A `pressed: Vec<Key>` set is maintained inside the callback. On every
//!    event we re-read the latest `Binding`, compute satisfaction, and emit
//!    `Pressed` / `Released` on transitions.
//! 4. If the event involves a key that's currently relevant to the binding
//!    (the primary key OR any of its modifiers, on either side as configured),
//!    we return `None` from the callback so the OS stops dispatching the event.
//!    Other events pass through unchanged.

use std::sync::{Arc, RwLock};
use std::thread;

use rdev::Key;
use tokio::sync::mpsc;

use super::binding::{Binding, ModifierKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyEvent {
    /// The bound action's binding became fully satisfied (transition from
    /// not-satisfied to satisfied).
    Pressed,
    /// The binding stopped being satisfied (any required key released).
    Released,
}

/// Spawns a background thread that listens to global keyboard events and
/// emits `HotkeyEvent::Pressed` / `Released` whenever the given binding's
/// satisfaction state changes.
///
/// The binding lives behind an `Arc<RwLock<_>>` so the settings UI can swap it
/// at runtime without restarting the listener.
#[cfg(target_os = "macos")]
pub fn spawn_listener(binding: Arc<RwLock<Binding>>, tx: mpsc::UnboundedSender<HotkeyEvent>) {
    thread::spawn(move || {
        macos::run(binding, tx);
    });
}

#[cfg(not(target_os = "macos"))]
pub fn spawn_listener(_binding: Arc<RwLock<Binding>>, _tx: mpsc::UnboundedSender<HotkeyEvent>) {
    tracing::warn!("hotkey listener is macOS-only; running as no-op on this platform");
}

/// Translate a Carbon HIToolbox `kVK_*` keycode (the value returned by
/// `CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode)`) to the
/// matching `rdev::Key`. Returns `None` for keys we don't track.
///
/// The table covers everything mappable via
/// [`crate::input::binding::key_from_code`] (DOM `KeyboardEvent.code` codes).
/// Source for the constants: Apple's `Carbon/HIToolbox/Events.h`.
pub fn cg_keycode_to_rdev_key(code: u16) -> Option<Key> {
    Some(match code {
        // Modifiers
        0x36 => Key::MetaRight,    // kVK_RightCommand
        0x37 => Key::MetaLeft,     // kVK_Command
        0x38 => Key::ShiftLeft,    // kVK_Shift
        0x3C => Key::ShiftRight,   // kVK_RightShift
        0x3A => Key::Alt,          // kVK_Option (left)
        0x3D => Key::AltGr,        // kVK_RightOption
        0x3B => Key::ControlLeft,  // kVK_Control
        0x3E => Key::ControlRight, // kVK_RightControl

        // Whitespace / control
        0x24 => Key::Return,    // kVK_Return
        0x30 => Key::Tab,       // kVK_Tab
        0x31 => Key::Space,     // kVK_Space
        0x33 => Key::Backspace, // kVK_Delete (backspace, not forward delete)
        0x35 => Key::Escape,    // kVK_Escape

        // Letters (kVK_ANSI_*)
        0x00 => Key::KeyA,
        0x0B => Key::KeyB,
        0x08 => Key::KeyC,
        0x02 => Key::KeyD,
        0x0E => Key::KeyE,
        0x03 => Key::KeyF,
        0x05 => Key::KeyG,
        0x04 => Key::KeyH,
        0x22 => Key::KeyI,
        0x26 => Key::KeyJ,
        0x28 => Key::KeyK,
        0x25 => Key::KeyL,
        0x2E => Key::KeyM,
        0x2D => Key::KeyN,
        0x1F => Key::KeyO,
        0x23 => Key::KeyP,
        0x0C => Key::KeyQ,
        0x0F => Key::KeyR,
        0x01 => Key::KeyS,
        0x11 => Key::KeyT,
        0x20 => Key::KeyU,
        0x09 => Key::KeyV,
        0x0D => Key::KeyW,
        0x07 => Key::KeyX,
        0x10 => Key::KeyY,
        0x06 => Key::KeyZ,

        // Top-row digits
        0x1D => Key::Num0,
        0x12 => Key::Num1,
        0x13 => Key::Num2,
        0x14 => Key::Num3,
        0x15 => Key::Num4,
        0x17 => Key::Num5,
        0x16 => Key::Num6,
        0x1A => Key::Num7,
        0x1C => Key::Num8,
        0x19 => Key::Num9,

        // Function row
        0x7A => Key::F1,
        0x78 => Key::F2,
        0x63 => Key::F3,
        0x76 => Key::F4,
        0x60 => Key::F5,
        0x61 => Key::F6,
        0x62 => Key::F7,
        0x64 => Key::F8,
        0x65 => Key::F9,
        0x6D => Key::F10,
        0x67 => Key::F11,
        0x6F => Key::F12,

        // Punctuation
        0x29 => Key::SemiColon,    // kVK_ANSI_Semicolon
        0x27 => Key::Quote,        // kVK_ANSI_Quote
        0x2B => Key::Comma,
        0x2F => Key::Dot,          // kVK_ANSI_Period
        0x2C => Key::Slash,
        0x2A => Key::BackSlash,
        0x21 => Key::LeftBracket,
        0x1E => Key::RightBracket,
        0x1B => Key::Minus,
        0x18 => Key::Equal,
        0x32 => Key::BackQuote,    // kVK_ANSI_Grave

        _ => return None,
    })
}

/// True iff `key` appears in `binding` (as primary or any modifier slot, on
/// either side as configured). Used to decide whether to swallow the event.
fn binding_uses_key(binding: &Binding, key: Key) -> bool {
    if binding.primary.0 == key {
        return true;
    }
    for (kind, side) in &binding.modifiers {
        let (left, right) = match kind {
            ModifierKind::Control => (Key::ControlLeft, Key::ControlRight),
            ModifierKind::Shift => (Key::ShiftLeft, Key::ShiftRight),
            ModifierKind::Alt => (Key::Alt, Key::AltGr),
            ModifierKind::Meta => (Key::MetaLeft, Key::MetaRight),
        };
        let matches = match side {
            super::binding::ModifierSide::Left => key == left,
            super::binding::ModifierSide::Right => key == right,
            super::binding::ModifierSide::Either => key == left || key == right,
        };
        if matches {
            return true;
        }
    }
    false
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;
    use std::sync::{Arc, RwLock};

    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_graphics::event::{
        CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
        CGEventType, EventField,
    };
    use rdev::Key;
    use tokio::sync::mpsc;
    use tracing::{error, info};

    use super::super::binding::Binding;
    use super::{binding_uses_key, cg_keycode_to_rdev_key, HotkeyEvent};

    pub fn run(binding: Arc<RwLock<Binding>>, tx: mpsc::UnboundedSender<HotkeyEvent>) {
        info!("starting CGEventTap hotkey listener");

        // The callback is `Fn` (not `FnMut`), so anything mutated across calls
        // lives in `RefCell`s captured by reference. Single-threaded — the tap
        // callback runs only on this run-loop thread.
        let pressed: RefCell<Vec<Key>> = RefCell::new(Vec::new());
        let satisfied: RefCell<bool> = RefCell::new(false);

        let tap = CGEventTap::new(
            CGEventTapLocation::HID,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::Default,
            vec![
                CGEventType::KeyDown,
                CGEventType::KeyUp,
                CGEventType::FlagsChanged,
            ],
            |_proxy, etype, event| {
                let keycode =
                    event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) as u16;
                let key = match cg_keycode_to_rdev_key(keycode) {
                    Some(k) => k,
                    None => return Some(event.clone()),
                };

                // Determine whether this event is a press or a release.
                // For KeyDown/KeyUp it's obvious. For FlagsChanged we infer
                // from the relevant CGEventFlags bit + which modifier keycode
                // fired.
                let is_press = match etype {
                    CGEventType::KeyDown => true,
                    CGEventType::KeyUp => false,
                    CGEventType::FlagsChanged => modifier_is_pressed(key, event.get_flags()),
                    _ => return Some(event.clone()),
                };

                let mut p = pressed.borrow_mut();
                if is_press {
                    if !p.contains(&key) {
                        p.push(key);
                    }
                } else {
                    p.retain(|k| *k != key);
                }

                let current_binding = match binding.read() {
                    Ok(b) => b.clone(),
                    Err(_) => return Some(event.clone()),
                };

                let now_satisfied = current_binding.is_satisfied_by(&p);
                let mut sat = satisfied.borrow_mut();
                if now_satisfied && !*sat {
                    *sat = true;
                    let _ = tx.send(HotkeyEvent::Pressed);
                } else if !now_satisfied && *sat {
                    *sat = false;
                    let _ = tx.send(HotkeyEvent::Released);
                }

                // Swallow the event if the key is part of the current binding.
                // Otherwise let it through.
                if binding_uses_key(&current_binding, key) {
                    None
                } else {
                    Some(event.clone())
                }
            },
        );

        let tap = match tap {
            Ok(t) => t,
            Err(_) => {
                error!(
                    "failed to create CGEventTap. Accessibility permission probably missing."
                );
                return;
            }
        };

        // Wire the tap into this thread's runloop and run forever.
        unsafe {
            let source = match tap.mach_port.create_runloop_source(0) {
                Ok(s) => s,
                Err(_) => {
                    error!("failed to create runloop source for CGEventTap");
                    return;
                }
            };
            CFRunLoop::get_current().add_source(&source, kCFRunLoopCommonModes);
            tap.enable();
            CFRunLoop::run_current();
        }
    }

    /// For a `FlagsChanged` event, return whether the given modifier key
    /// (which we already mapped to an `rdev::Key`) is now pressed. We check
    /// the appropriate `CGEventFlags` bit. Note: macOS doesn't distinguish
    /// left/right at the flags level (both ShiftLeft and ShiftRight set the
    /// `Shift` flag), so we additionally consult the keycode's identity to
    /// decide whether THIS event is a press or a release of THIS specific
    /// side.
    ///
    /// Strategy: if the flags-bit for this modifier kind is currently set
    /// AND the corresponding side wasn't already pressed, treat as press.
    /// Otherwise treat as release. We approximate this with: "the flag is
    /// set" → press, "the flag is clear" → release. The settled semantics
    /// are good enough for satisfying-binding detection because the
    /// `pressed` Vec is dedup'd (re-pressing an already-pressed key is a
    /// no-op).
    fn modifier_is_pressed(key: Key, flags: CGEventFlags) -> bool {
        match key {
            Key::ShiftLeft | Key::ShiftRight => flags.contains(CGEventFlags::CGEventFlagShift),
            Key::ControlLeft | Key::ControlRight => {
                flags.contains(CGEventFlags::CGEventFlagControl)
            }
            Key::Alt | Key::AltGr => flags.contains(CGEventFlags::CGEventFlagAlternate),
            Key::MetaLeft | Key::MetaRight => flags.contains(CGEventFlags::CGEventFlagCommand),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cg_keycode_to_rdev_key_covers_modifiers() {
        assert_eq!(cg_keycode_to_rdev_key(0x37), Some(Key::MetaLeft));
        assert_eq!(cg_keycode_to_rdev_key(0x36), Some(Key::MetaRight));
        assert_eq!(cg_keycode_to_rdev_key(0x3B), Some(Key::ControlLeft));
        assert_eq!(cg_keycode_to_rdev_key(0x3E), Some(Key::ControlRight));
        assert_eq!(cg_keycode_to_rdev_key(0x38), Some(Key::ShiftLeft));
        assert_eq!(cg_keycode_to_rdev_key(0x3C), Some(Key::ShiftRight));
        assert_eq!(cg_keycode_to_rdev_key(0x3A), Some(Key::Alt));
        assert_eq!(cg_keycode_to_rdev_key(0x3D), Some(Key::AltGr));
    }

    #[test]
    fn cg_keycode_to_rdev_key_covers_letters_and_digits() {
        assert_eq!(cg_keycode_to_rdev_key(0x00), Some(Key::KeyA));
        assert_eq!(cg_keycode_to_rdev_key(0x06), Some(Key::KeyZ));
        assert_eq!(cg_keycode_to_rdev_key(0x12), Some(Key::Num1));
        assert_eq!(cg_keycode_to_rdev_key(0x1D), Some(Key::Num0));
    }

    #[test]
    fn cg_keycode_to_rdev_key_unknown_returns_none() {
        assert_eq!(cg_keycode_to_rdev_key(0xFFFF), None);
        // 0x39 is CapsLock, intentionally not mapped.
        assert_eq!(cg_keycode_to_rdev_key(0x39), None);
    }

    #[test]
    fn binding_uses_key_detects_primary_and_modifier() {
        use crate::input::binding::{ModifierKind, ModifierSide, SerKey};
        let b = Binding {
            primary: SerKey(Key::KeyL),
            modifiers: vec![(ModifierKind::Meta, ModifierSide::Right)],
        };
        assert!(binding_uses_key(&b, Key::KeyL));
        assert!(binding_uses_key(&b, Key::MetaRight));
        assert!(!binding_uses_key(&b, Key::MetaLeft));
        assert!(!binding_uses_key(&b, Key::KeyA));
    }
}

