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

use super::binding::Binding;

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
///
/// `suspended` — when `true` the tap passes all events through without
/// swallowing or emitting, so the UI can capture raw key events for rebinding.
#[cfg(target_os = "macos")]
pub fn spawn_listener(
    binding: Arc<RwLock<Binding>>,
    tx: mpsc::UnboundedSender<HotkeyEvent>,
    suspended: Arc<std::sync::atomic::AtomicBool>,
) {
    thread::spawn(move || {
        macos::run(binding, tx, suspended);
    });
}

#[cfg(not(target_os = "macos"))]
pub fn spawn_listener(
    _binding: Arc<RwLock<Binding>>,
    _tx: mpsc::UnboundedSender<HotkeyEvent>,
    _suspended: Arc<std::sync::atomic::AtomicBool>,
) {
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


#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::ptr;
    use std::sync::{Arc, RwLock};
    use std::sync::atomic::{AtomicBool, Ordering};

    use core_foundation::runloop::kCFRunLoopCommonModes;
    use rdev::Key;
    use tokio::sync::mpsc;
    use tracing::{error, info};

    use super::super::binding::Binding;
    use super::{cg_keycode_to_rdev_key, HotkeyEvent};

    // ── Raw CoreGraphics / CoreFoundation FFI ──────────────────────────────────
    //
    // The core-graphics 0.24 Rust wrapper's CGEventTap callback bridge always
    // returns the original (non-null) CGEventRef from the C callback — even when
    // the Rust closure returns `None`. Apple documents that returning NULL from a
    // CGEventTap callback *deletes* the event and prevents delivery to any
    // downstream tap or application. Because the wrapper never returns NULL, using
    // `set_type(CGEventType::Null)` + `Some(event)` does NOT suppress character
    // delivery — the OS still dispatches the character data embedded in the event.
    //
    // Solution: bypass the wrapper and call CGEventTapCreate directly via raw FFI
    // so our `extern "C"` callback can return `ptr::null_mut()` to truly delete
    // events we want to swallow.

    type CGEventRef = *mut c_void;
    type CGEventTapProxy = *mut c_void;
    type CFMachPortRef = *mut c_void;
    type CFRunLoopSourceRef = *mut c_void;
    type CFRunLoopRef = *mut c_void;

    const CG_HID_EVENT_TAP: u32 = 0;
    const KCG_HEAD_INSERT_EVENT_TAP: u32 = 0;
    const KCG_EVENT_TAP_OPTION_DEFAULT: u32 = 0;

    const CG_EVENT_KEY_DOWN: u32 = 10;
    const CG_EVENT_KEY_UP: u32 = 11;
    const CG_EVENT_FLAGS_CHANGED: u32 = 12;

    const EVENT_MASK: u64 = (1u64 << CG_EVENT_KEY_DOWN)
        | (1u64 << CG_EVENT_KEY_UP)
        | (1u64 << CG_EVENT_FLAGS_CHANGED);

    const KEYBOARD_EVENT_KEYCODE_FIELD: i32 = 9; // kCGKeyboardEventKeycode

    const CG_FLAG_SHIFT: u64     = 0x0002_0000;
    const CG_FLAG_CONTROL: u64   = 0x0004_0000;
    const CG_FLAG_ALTERNATE: u64 = 0x0008_0000;
    const CG_FLAG_COMMAND: u64   = 0x0010_0000;

    extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: unsafe extern "C" fn(
                CGEventTapProxy,
                u32,
                CGEventRef,
                *mut c_void,
            ) -> CGEventRef,
            user_info: *mut c_void,
        ) -> CFMachPortRef;

        fn CGEventGetIntegerValueField(event: CGEventRef, field: i32) -> i64;
        fn CGEventGetFlags(event: CGEventRef) -> u64;
        fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);

        fn CFMachPortCreateRunLoopSource(
            allocator: *const c_void,
            port: CFMachPortRef,
            order: isize,
        ) -> CFRunLoopSourceRef;

        fn CFRunLoopGetCurrent() -> CFRunLoopRef;
        fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: *const c_void);
        fn CFRunLoopRun();
        fn CFRelease(cf: *const c_void);
    }

    // ── Tap state ──────────────────────────────────────────────────────────────
    // Each listener thread has exactly one tap. We box the state and pass it as
    // the user_info pointer. The box is intentionally leaked — the tap runs for
    // the application's lifetime and is never torn down.

    struct TapState {
        binding: Arc<RwLock<Binding>>,
        tx: mpsc::UnboundedSender<HotkeyEvent>,
        suspended: Arc<AtomicBool>,
        pressed: Vec<Key>,
        satisfied: bool,
    }

    unsafe extern "C" fn tap_callback(
        _proxy: CGEventTapProxy,
        event_type: u32,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef {
        if event.is_null() {
            return event;
        }

        let state = &mut *(user_info as *mut TapState);

        if state.suspended.load(Ordering::SeqCst) {
            return event;
        }

        let keycode = CGEventGetIntegerValueField(event, KEYBOARD_EVENT_KEYCODE_FIELD) as u16;
        let key = match cg_keycode_to_rdev_key(keycode) {
            Some(k) => k,
            None => return event,
        };

        let flags = CGEventGetFlags(event);

        let is_press = match event_type {
            CG_EVENT_KEY_DOWN => true,
            CG_EVENT_KEY_UP => false,
            CG_EVENT_FLAGS_CHANGED => modifier_is_pressed(key, flags),
            _ => return event,
        };

        if is_press {
            if !state.pressed.contains(&key) {
                state.pressed.push(key);
            }
        } else {
            state.pressed.retain(|k| *k != key);
        }

        let binding = match state.binding.read() {
            Ok(b) => b.clone(),
            Err(_) => return event,
        };

        let now_satisfied = binding.is_satisfied_by(&state.pressed);
        let was_satisfied = state.satisfied;

        if now_satisfied && !was_satisfied {
            state.satisfied = true;
            let _ = state.tx.send(HotkeyEvent::Pressed);
        } else if !now_satisfied && was_satisfied {
            state.satisfied = false;
            let _ = state.tx.send(HotkeyEvent::Released);
        }

        // Swallow the PRIMARY key (never modifiers) when the binding is/was satisfied.
        // Returning NULL from a CGEventTap callback deletes the event — the only
        // reliable way to prevent character delivery for non-modifier keys.
        // We never swallow modifier keys so that shared modifiers (e.g. AltGr used
        // alone for voice-at-cursor AND as part of Option+/ for log-capture) still
        // reach the other tap, letting it observe the release and reset its state.
        if key == binding.primary.0 && (was_satisfied || now_satisfied) {
            return ptr::null_mut();
        }

        event
    }

    fn modifier_is_pressed(key: Key, flags: u64) -> bool {
        match key {
            Key::ShiftLeft | Key::ShiftRight     => flags & CG_FLAG_SHIFT != 0,
            Key::ControlLeft | Key::ControlRight => flags & CG_FLAG_CONTROL != 0,
            Key::Alt | Key::AltGr                => flags & CG_FLAG_ALTERNATE != 0,
            Key::MetaLeft | Key::MetaRight        => flags & CG_FLAG_COMMAND != 0,
            _ => false,
        }
    }

    pub fn run(
        binding: Arc<RwLock<Binding>>,
        tx: mpsc::UnboundedSender<HotkeyEvent>,
        suspended: Arc<AtomicBool>,
    ) {
        info!("starting CGEventTap hotkey listener");

        let state = Box::into_raw(Box::new(TapState {
            binding,
            tx,
            suspended,
            pressed: Vec::new(),
            satisfied: false,
        }));

        unsafe {
            let tap = CGEventTapCreate(
                CG_HID_EVENT_TAP,
                KCG_HEAD_INSERT_EVENT_TAP,
                KCG_EVENT_TAP_OPTION_DEFAULT,
                EVENT_MASK,
                tap_callback,
                state as *mut c_void,
            );

            if tap.is_null() {
                error!("failed to create CGEventTap — Accessibility permission probably missing.");
                drop(Box::from_raw(state));
                return;
            }

            let source = CFMachPortCreateRunLoopSource(ptr::null(), tap, 0);
            if source.is_null() {
                error!("failed to create runloop source for CGEventTap");
                CFRelease(tap as *const c_void);
                drop(Box::from_raw(state));
                return;
            }

            let rl = CFRunLoopGetCurrent();
            CFRunLoopAddSource(rl, source, kCFRunLoopCommonModes as *const c_void);
            CGEventTapEnable(tap, true);
            CFRelease(source as *const c_void); // run loop holds its own retain

            CFRunLoopRun(); // blocks until the process exits
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

}

