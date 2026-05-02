use rdev::Key;
use serde::{Deserialize, Serialize};

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

/// Serializable wrapper around `rdev::Key` since rdev's `Key` doesn't impl Serialize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SerKey(pub Key);

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
