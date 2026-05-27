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

/// True for the modifier keys (Shift / Control / Alt / Meta, either side).
///
/// Modifiers are never swallowed by the tap (see [`should_swallow`]) so that a
/// modifier bound to one action (e.g. Right Option for voice-at-cursor) still
/// reaches the *other* listeners' taps, letting a combo that shares that
/// modifier (e.g. Right Option + `/` for log-capture) observe it and satisfy.
pub fn is_modifier(key: Key) -> bool {
    matches!(
        key,
        Key::ShiftLeft
            | Key::ShiftRight
            | Key::ControlLeft
            | Key::ControlRight
            | Key::Alt
            | Key::AltGr
            | Key::MetaLeft
            | Key::MetaRight
    )
}

/// Decide whether the tap should delete (swallow) this key event so it never
/// reaches the focused app.
///
/// We only swallow the binding's **primary** key, and only while the binding is
/// (or just was) satisfied — so the character/keystroke doesn't leak. We never
/// swallow a modifier, even when it IS the primary (single-modifier bindings
/// like bare Right Option): deleting a shared modifier would starve the other
/// listeners' taps and break combos that build on it.
pub fn should_swallow(
    key: Key,
    binding: &Binding,
    was_satisfied: bool,
    now_satisfied: bool,
) -> bool {
    key == binding.primary.0 && !is_modifier(key) && (was_satisfied || now_satisfied)
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
        if super::should_swallow(key, &binding, was_satisfied, now_satisfied) {
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

    use super::super::binding::{Binding, ModifierKind, ModifierSide, SerKey};

    /// Bare single-modifier binding (voice-at-cursor = Right Option). The shared
    /// modifier must NOT be swallowed, otherwise the log-capture tap never sees
    /// Right Option and `Right Option + /` can never satisfy.
    #[test]
    fn does_not_swallow_a_bare_modifier_primary() {
        let voice = Binding::single(Key::AltGr); // Right Option
        assert!(
            !should_swallow(Key::AltGr, &voice, true, true),
            "bare modifier primary must not be swallowed"
        );
    }

    /// Same guarantee for a bare Right Control voice binding.
    #[test]
    fn does_not_swallow_bare_right_control() {
        let voice = Binding::single(Key::ControlRight);
        assert!(!should_swallow(Key::ControlRight, &voice, true, true));
    }

    /// A non-modifier primary (log-capture's `/`) is still swallowed so the
    /// slash never leaks into the focused text field.
    #[test]
    fn swallows_non_modifier_primary_when_satisfied() {
        let log = Binding {
            primary: SerKey(Key::Slash),
            modifiers: vec![(ModifierKind::Alt, ModifierSide::Right)],
        };
        assert!(should_swallow(Key::Slash, &log, true, true));
        assert!(should_swallow(Key::Slash, &log, false, true)); // becoming satisfied
        assert!(should_swallow(Key::Slash, &log, true, false)); // just released
    }

    /// Never swallow when the binding isn't (and wasn't) satisfied, nor a key
    /// that isn't the primary.
    #[test]
    fn does_not_swallow_unsatisfied_or_non_primary() {
        let log = Binding {
            primary: SerKey(Key::Slash),
            modifiers: vec![(ModifierKind::Alt, ModifierSide::Right)],
        };
        assert!(!should_swallow(Key::Slash, &log, false, false));
        assert!(!should_swallow(Key::KeyB, &log, true, true));
    }

    #[test]
    fn is_modifier_classifies_sides() {
        assert!(is_modifier(Key::AltGr));
        assert!(is_modifier(Key::ControlRight));
        assert!(is_modifier(Key::ShiftLeft));
        assert!(is_modifier(Key::MetaRight));
        assert!(!is_modifier(Key::Slash));
        assert!(!is_modifier(Key::KeyA));
    }

    // ── Multi-tap chain simulation ───────────────────────────────────────────
    //
    // Each listener runs its own CGEventTap. Taps fire in chain order; a tap
    // that swallows an event (returns NULL) DELETES it, so taps later in the
    // chain never see it. This models that interaction in pure Rust so we can
    // regression-guard the shared-modifier collision without the FFI/runloop.

    /// One tap's view of the world: its binding + the keys it has observed.
    struct SimTap {
        binding: Binding,
        pressed: Vec<Key>,
        satisfied: bool,
    }

    impl SimTap {
        fn new(binding: Binding) -> Self {
            Self { binding, pressed: Vec::new(), satisfied: false }
        }

        /// Mirror of `tap_callback`: update pressed set, compute transition,
        /// decide swallow. Returns `(transition, swallow)`.
        fn feed(&mut self, key: Key, is_press: bool) -> (Option<HotkeyEvent>, bool) {
            if is_press {
                if !self.pressed.contains(&key) {
                    self.pressed.push(key);
                }
            } else {
                self.pressed.retain(|k| *k != key);
            }
            let now = self.binding.is_satisfied_by(&self.pressed);
            let was = self.satisfied;
            let transition = if now && !was {
                self.satisfied = true;
                Some(HotkeyEvent::Pressed)
            } else if !now && was {
                self.satisfied = false;
                Some(HotkeyEvent::Released)
            } else {
                None
            };
            let swallow = should_swallow(key, &self.binding, was, now);
            (transition, swallow)
        }
    }

    /// Run one key event through the tap chain in order. Returns the transitions
    /// emitted, tagged by tap index, plus whether any tap swallowed the event.
    fn run_chain(
        taps: &mut [SimTap],
        key: Key,
        is_press: bool,
    ) -> (Vec<(usize, HotkeyEvent)>, bool) {
        let mut emitted = Vec::new();
        let mut swallowed = false;
        for (i, tap) in taps.iter_mut().enumerate() {
            let (transition, swallow) = tap.feed(key, is_press);
            if let Some(ev) = transition {
                emitted.push((i, ev));
            }
            if swallow {
                swallowed = true;
                break; // event deleted — later taps never see it
            }
        }
        (emitted, swallowed)
    }

    fn voice_binding() -> Binding {
        Binding::single(Key::AltGr) // bare Right Option
    }

    fn log_binding() -> Binding {
        Binding {
            primary: SerKey(Key::Slash),
            modifiers: vec![(ModifierKind::Alt, ModifierSide::Right)],
        }
    }

    /// THE regression: voice = bare Right Option, notes = Right Option + `/`.
    /// Voice tap is FIRST in chain (the ordering that broke). Pressing the
    /// shared modifier must NOT be swallowed, so the log-capture tap still sees
    /// it and `Right Option + /` fires LogCapture. With the old bug (swallow
    /// the bare modifier primary) the log tap never saw Right Option and this
    /// emitted nothing for tap 1.
    #[test]
    fn shared_modifier_combo_still_fires_log_capture() {
        let mut taps = [SimTap::new(voice_binding()), SimTap::new(log_binding())];

        // Press Right Option: voice (tap 0) fires Pressed; NOT swallowed.
        let (events, swallowed) = run_chain(&mut taps, Key::AltGr, true);
        assert_eq!(events, vec![(0, HotkeyEvent::Pressed)]);
        assert!(!swallowed, "shared modifier must reach the log-capture tap");

        // Press Slash: voice passes it through (not its primary); log (tap 1)
        // now satisfied → fires Pressed, and swallows `/` so it can't leak.
        let (events, swallowed) = run_chain(&mut taps, Key::Slash, true);
        assert_eq!(events, vec![(1, HotkeyEvent::Pressed)]);
        assert!(swallowed, "the `/` primary must be swallowed (not leak as text)");
    }

    /// Releasing the slash drops log-capture; releasing Right Option drops voice.
    #[test]
    fn shared_modifier_combo_releases_cleanly() {
        let mut taps = [SimTap::new(voice_binding()), SimTap::new(log_binding())];
        run_chain(&mut taps, Key::AltGr, true);
        run_chain(&mut taps, Key::Slash, true);

        let (events, _) = run_chain(&mut taps, Key::Slash, false);
        assert_eq!(events, vec![(1, HotkeyEvent::Released)]);

        let (events, _) = run_chain(&mut taps, Key::AltGr, false);
        assert_eq!(events, vec![(0, HotkeyEvent::Released)]);
    }

    /// Voice-at-cursor alone (just tap Right Option) still works: fires on
    /// press, releases on release. The bare modifier leaks to the OS, which is
    /// harmless — Right Option alone produces no character/action.
    #[test]
    fn bare_modifier_voice_at_cursor_fires_alone() {
        let mut taps = [SimTap::new(voice_binding()), SimTap::new(log_binding())];

        let (events, swallowed) = run_chain(&mut taps, Key::AltGr, true);
        assert_eq!(events, vec![(0, HotkeyEvent::Pressed)]);
        assert!(!swallowed);

        let (events, _) = run_chain(&mut taps, Key::AltGr, false);
        assert_eq!(events, vec![(0, HotkeyEvent::Released)]);
    }
}

