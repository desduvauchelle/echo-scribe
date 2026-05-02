use rdev::Key;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModifierSide {
    Left,
    Right,
    Either,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModifierKind {
    Control,
    Shift,
    Alt,
    Meta,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    pub primary: SerKey,
    pub modifiers: Vec<(ModifierKind, ModifierSide)>,
}

/// Serializable wrapper around `rdev::Key`.
///
/// We implement (de)serialization manually via a stable string mapping
/// (DOM `KeyboardEvent.code` strings) instead of relying on rdev's `serialize`
/// feature flag. The rustdesk fork of rdev we depend on has a broken
/// `serialize` feature on its `Event` type, and serializing a Rust enum's
/// variant names directly would tie the on-disk settings format to rdev's
/// internal naming. The string mapping lives in [`code_from_key`] /
/// [`key_from_code`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SerKey(pub Key);

impl Serialize for SerKey {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        match code_from_key(self.0) {
            Some(s) => ser.serialize_str(s),
            None => Err(serde::ser::Error::custom(format!(
                "rdev::Key variant {:?} has no DOM-code mapping",
                self.0
            ))),
        }
    }
}

impl<'de> Deserialize<'de> for SerKey {
    fn deserialize<D: Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let s = String::deserialize(de)?;
        key_from_code(&s)
            .map(SerKey)
            .ok_or_else(|| serde::de::Error::custom(format!("unknown key code: {s}")))
    }
}

/// Map a DOM `KeyboardEvent.code` string to the corresponding `rdev::Key`.
///
/// Returns `None` for codes we haven't enumerated. Callers should treat that
/// as a hard validation failure (the user picked something unsupported).
pub fn key_from_code(s: &str) -> Option<Key> {
    Some(match s {
        // Modifiers
        "ControlLeft" => Key::ControlLeft,
        "ControlRight" => Key::ControlRight,
        "ShiftLeft" => Key::ShiftLeft,
        "ShiftRight" => Key::ShiftRight,
        "AltLeft" => Key::Alt,
        "AltRight" => Key::AltGr,
        "MetaLeft" => Key::MetaLeft,
        "MetaRight" => Key::MetaRight,
        // Whitespace / control
        "Space" => Key::Space,
        "Tab" => Key::Tab,
        "Escape" => Key::Escape,
        "Enter" => Key::Return,
        "Backspace" => Key::Backspace,
        // Letters
        "KeyA" => Key::KeyA,
        "KeyB" => Key::KeyB,
        "KeyC" => Key::KeyC,
        "KeyD" => Key::KeyD,
        "KeyE" => Key::KeyE,
        "KeyF" => Key::KeyF,
        "KeyG" => Key::KeyG,
        "KeyH" => Key::KeyH,
        "KeyI" => Key::KeyI,
        "KeyJ" => Key::KeyJ,
        "KeyK" => Key::KeyK,
        "KeyL" => Key::KeyL,
        "KeyM" => Key::KeyM,
        "KeyN" => Key::KeyN,
        "KeyO" => Key::KeyO,
        "KeyP" => Key::KeyP,
        "KeyQ" => Key::KeyQ,
        "KeyR" => Key::KeyR,
        "KeyS" => Key::KeyS,
        "KeyT" => Key::KeyT,
        "KeyU" => Key::KeyU,
        "KeyV" => Key::KeyV,
        "KeyW" => Key::KeyW,
        "KeyX" => Key::KeyX,
        "KeyY" => Key::KeyY,
        "KeyZ" => Key::KeyZ,
        // Top-row digits
        "Digit0" => Key::Num0,
        "Digit1" => Key::Num1,
        "Digit2" => Key::Num2,
        "Digit3" => Key::Num3,
        "Digit4" => Key::Num4,
        "Digit5" => Key::Num5,
        "Digit6" => Key::Num6,
        "Digit7" => Key::Num7,
        "Digit8" => Key::Num8,
        "Digit9" => Key::Num9,
        // Function row
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        // F13–F19 aren't all in rdev::Key — only F1–F12 are reliably present in
        // rdev 0.5. We map F13+ to None.
        // Punctuation
        "Period" => Key::Dot,
        "Comma" => Key::Comma,
        "Semicolon" => Key::SemiColon,
        "Quote" => Key::Quote,
        "BracketLeft" => Key::LeftBracket,
        "BracketRight" => Key::RightBracket,
        "Backslash" => Key::BackSlash,
        "Slash" => Key::Slash,
        "Minus" => Key::Minus,
        "Equal" => Key::Equal,
        "Backquote" => Key::BackQuote,
        _ => return None,
    })
}

/// Inverse of [`key_from_code`]. Returns `None` if the key isn't in our table.
pub fn code_from_key(k: Key) -> Option<&'static str> {
    Some(match k {
        Key::ControlLeft => "ControlLeft",
        Key::ControlRight => "ControlRight",
        Key::ShiftLeft => "ShiftLeft",
        Key::ShiftRight => "ShiftRight",
        Key::Alt => "AltLeft",
        Key::AltGr => "AltRight",
        Key::MetaLeft => "MetaLeft",
        Key::MetaRight => "MetaRight",
        Key::Space => "Space",
        Key::Tab => "Tab",
        Key::Escape => "Escape",
        Key::Return => "Enter",
        Key::Backspace => "Backspace",
        Key::KeyA => "KeyA",
        Key::KeyB => "KeyB",
        Key::KeyC => "KeyC",
        Key::KeyD => "KeyD",
        Key::KeyE => "KeyE",
        Key::KeyF => "KeyF",
        Key::KeyG => "KeyG",
        Key::KeyH => "KeyH",
        Key::KeyI => "KeyI",
        Key::KeyJ => "KeyJ",
        Key::KeyK => "KeyK",
        Key::KeyL => "KeyL",
        Key::KeyM => "KeyM",
        Key::KeyN => "KeyN",
        Key::KeyO => "KeyO",
        Key::KeyP => "KeyP",
        Key::KeyQ => "KeyQ",
        Key::KeyR => "KeyR",
        Key::KeyS => "KeyS",
        Key::KeyT => "KeyT",
        Key::KeyU => "KeyU",
        Key::KeyV => "KeyV",
        Key::KeyW => "KeyW",
        Key::KeyX => "KeyX",
        Key::KeyY => "KeyY",
        Key::KeyZ => "KeyZ",
        Key::Num0 => "Digit0",
        Key::Num1 => "Digit1",
        Key::Num2 => "Digit2",
        Key::Num3 => "Digit3",
        Key::Num4 => "Digit4",
        Key::Num5 => "Digit5",
        Key::Num6 => "Digit6",
        Key::Num7 => "Digit7",
        Key::Num8 => "Digit8",
        Key::Num9 => "Digit9",
        Key::F1 => "F1",
        Key::F2 => "F2",
        Key::F3 => "F3",
        Key::F4 => "F4",
        Key::F5 => "F5",
        Key::F6 => "F6",
        Key::F7 => "F7",
        Key::F8 => "F8",
        Key::F9 => "F9",
        Key::F10 => "F10",
        Key::F11 => "F11",
        Key::F12 => "F12",
        Key::Dot => "Period",
        Key::Comma => "Comma",
        Key::SemiColon => "Semicolon",
        Key::Quote => "Quote",
        Key::LeftBracket => "BracketLeft",
        Key::RightBracket => "BracketRight",
        Key::BackSlash => "Backslash",
        Key::Slash => "Slash",
        Key::Minus => "Minus",
        Key::Equal => "Equal",
        Key::BackQuote => "Backquote",
        _ => return None,
    })
}

impl Binding {
    /// A single-key binding. No modifiers.
    pub fn single(key: Key) -> Self {
        Self { primary: SerKey(key), modifiers: Vec::new() }
    }

    /// True if the binding is a single key (no modifiers required).
    pub fn is_single(&self) -> bool {
        self.modifiers.is_empty()
    }

    /// Check whether the given currently-pressed-keys set satisfies this binding.
    pub fn is_satisfied_by(&self, pressed: &[Key]) -> bool {
        // primary must be pressed
        if !pressed.contains(&self.primary.0) {
            return false;
        }
        // every required modifier must be pressed on the right side
        for (kind, side) in &self.modifiers {
            if !modifier_satisfied(*kind, *side, pressed) {
                return false;
            }
        }
        true
    }
}

fn modifier_satisfied(kind: ModifierKind, side: ModifierSide, pressed: &[Key]) -> bool {
    let (left, right) = match kind {
        ModifierKind::Control => (Key::ControlLeft, Key::ControlRight),
        ModifierKind::Shift => (Key::ShiftLeft, Key::ShiftRight),
        ModifierKind::Alt => (Key::Alt, Key::AltGr),
        ModifierKind::Meta => (Key::MetaLeft, Key::MetaRight),
    };
    let left_pressed = pressed.contains(&left);
    let right_pressed = pressed.contains(&right);
    match side {
        ModifierSide::Left => left_pressed,
        ModifierSide::Right => right_pressed,
        ModifierSide::Either => left_pressed || right_pressed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_key_binding_is_satisfied_when_key_pressed() {
        let b = Binding::single(Key::ControlRight);
        assert!(b.is_satisfied_by(&[Key::ControlRight]));
        assert!(!b.is_satisfied_by(&[Key::ControlLeft]));
        assert!(!b.is_satisfied_by(&[]));
    }

    #[test]
    fn combo_requires_both_primary_and_modifier() {
        let b = Binding {
            primary: SerKey(Key::KeyL),
            modifiers: vec![(ModifierKind::Meta, ModifierSide::Right)],
        };
        assert!(b.is_satisfied_by(&[Key::KeyL, Key::MetaRight]));
        assert!(!b.is_satisfied_by(&[Key::KeyL, Key::MetaLeft]));
        assert!(!b.is_satisfied_by(&[Key::KeyL]));
    }

    #[test]
    fn either_side_modifier_accepts_left_or_right() {
        let b = Binding {
            primary: SerKey(Key::KeyL),
            modifiers: vec![(ModifierKind::Shift, ModifierSide::Either)],
        };
        assert!(b.is_satisfied_by(&[Key::KeyL, Key::ShiftLeft]));
        assert!(b.is_satisfied_by(&[Key::KeyL, Key::ShiftRight]));
        assert!(!b.is_satisfied_by(&[Key::KeyL]));
    }

    #[test]
    fn is_single_distinguishes_combos_from_singles() {
        assert!(Binding::single(Key::ControlRight).is_single());
        let combo = Binding {
            primary: SerKey(Key::KeyL),
            modifiers: vec![(ModifierKind::Meta, ModifierSide::Right)],
        };
        assert!(!combo.is_single());
    }
}
