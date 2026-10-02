//! One column for every small notice that floats near Tucky or the recording pill.
//!
//! The anchor is the desktop pet when it is out, otherwise the recording pill
//! (its last position when hidden, so notices keep a stable home). Cards stack
//! upward from the anchor with the same visible gap between every card: the
//! persistent daily-focus bubble sits nearest the pet, then the pill (with the
//! pet), then transient notices in the order they appeared. New notices append
//! on top, so an arriving toast never shifts the ones already on screen, and a
//! card that grows only moves its own top edge.
//! Recording status sits separately to the pet's left (right at the left edge).
//!
//! Each notice window keeps transparent padding around its visible card for the
//! shadow and pointer tail; `insets` mirrors that CSS so spacing is computed on
//! the cards the user actually sees, not on the window frames. Only the card
//! nearest the visible pet draws a tail, aimed at its head
//! (`bubble-tail` event + `bubble_tail` command).
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tracing::debug;

/// Visible gap between two stacked cards (logical px).
const CARD_GAP: f64 = 10.0;
/// Space between the anchor and the nearest card's body: the 8–9px tail plus
/// a few px of air before the tip.
const TAIL_CLEARANCE: f64 = 14.0;
/// Transparent space above Tucky's ears inside the pet window (`main` padding).
const PET_TOP_PADDING: f64 = 4.0;

// Shared paint gutters; keep in sync with styles/speech-bubble.css.
pub(crate) const BUBBLE_TOP: f64 = 28.0;
pub(crate) const BUBBLE_SIDE: f64 = 32.0;
pub(crate) const BUBBLE_BOTTOM: f64 = 44.0;
pub(crate) const BUBBLE_WIDTH_INSET: f64 = BUBBLE_SIDE * 2.0;
pub(crate) const BUBBLE_HEIGHT_INSET: f64 = BUBBLE_TOP + BUBBLE_BOTTOM;

/// Transparent (top, right, bottom, left) padding around each window's card,
/// in logical px. Keep in sync with the stage/margin rules in each window's CSS.
fn insets(label: &str) -> (f64, f64, f64, f64) {
    match label {
        "recording_overlay" => (0.0, 0.0, 0.0, 0.0),
        "consent_overlay" => (6.0, 6.0, 6.0, 6.0),
        _ => (BUBBLE_TOP, BUBBLE_SIDE, BUBBLE_BOTTOM, BUBBLE_SIDE),
    }
}

/// Notices that join the column in the order they are shown.
const TRANSIENT: [&str; 5] = [
    "activity_bubble",
    "agent_toast",
    "action_toast",
    "meeting_start_toast",
    "consent_overlay",
];

static ORDER: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
static TAILS: Mutex<Option<HashMap<String, Tail>>> = Mutex::new(None);

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct Tail {
    /// "bottom" when this card is nearest the anchor, else "none".
    side: &'static str,
    /// Tail center in logical px from the card's left edge.
    x: f64,
}

impl Tail {
    pub(crate) fn has_tail(self) -> bool { self.side == "bottom" }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Rect {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

impl Rect {
    fn right(self) -> i64 {
        self.x + self.width
    }
    fn bottom(self) -> i64 {
        self.y + self.height
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Item {
    pub width: i64,
    pub height: i64,
    /// Recording status belongs beside the pet, outside the notice column.
    pub beside_pet: bool,
    /// (top, right, bottom, left) transparent padding, physical px.
    pub insets: (i64, i64, i64, i64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Align {
    /// Line the cards up with the pet's edge that faces the screen center.
    Pet,
    /// Center the cards over the anchor (the recording pill).
    Center,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Slot {
    pub x: i64,
    pub y: i64,
    /// Tail center in physical px from the card's left edge, nearest card only.
    pub tail_x: Option<i64>,
}

/// Keep recording status beside the pet without consuming a notice-column slot.
/// All dimensions and paint insets are physical px.
pub(crate) fn layout(
    anchor: Rect,
    items: &[Item],
    area: Rect,
    align: Align,
    gap: i64,
    clearance: i64,
) -> Vec<Slot> {
    if align != Align::Pet || !items.iter().any(|item| item.beside_pet) {
        return layout_column(anchor, items, area, align, gap, clearance);
    }
    let column: Vec<_> = items.iter().copied().filter(|item| !item.beside_pet).collect();
    let mut slots = layout_column(anchor, &column, area, align, gap, clearance).into_iter();
    items.iter().map(|item| {
        if !item.beside_pet {
            return slots.next().expect("one column slot per notice");
        }
        let (top, right, bottom, left) = item.insets;
        let card_height = item.height - top - bottom;
        // Align visible card edges, retaining the transparent shadow gutters.
        let left_x = anchor.x - gap - (item.width - right);
        let x = if left_x >= area.x { left_x } else { anchor.right() + gap - left };
        let y = anchor.y + (anchor.height - card_height) / 2 - top;
        Slot {
            x: x.clamp(area.x, (area.right() - item.width).max(area.x)),
            y: y.clamp(area.y, (area.bottom() - item.height).max(area.y)),
            tail_x: None,
        }
    }).collect()
}

/// Pure column layout, physical px. `gap` is between cards, `clearance` between the
/// anchor and the nearest card. Stacks upward; if the column would leave the
/// work area it stacks downward below the anchor instead (no tails).
fn layout_column(
    anchor: Rect,
    items: &[Item],
    area: Rect,
    align: Align,
    gap: i64,
    clearance: i64,
) -> Vec<Slot> {
    let anchor_center = anchor.x + anchor.width / 2;
    let face_right = anchor_center > area.x + area.width / 2;
    let x_for = |item: &Item| {
        let (_, right, _, left) = item.insets;
        let card_width = item.width - left - right;
        let card_x = match align {
            Align::Center => anchor_center - card_width / 2,
            Align::Pet if face_right => anchor.right() - card_width,
            Align::Pet => anchor.x,
        };
        (card_x - left).clamp(area.x, (area.right() - item.width).max(area.x))
    };

    let mut slots = Vec::with_capacity(items.len());
    let mut card_bottom = anchor.y - clearance;
    for item in items {
        let (top, _, bottom, _) = item.insets;
        let y = card_bottom + bottom - item.height;
        slots.push(Slot { x: x_for(item), y, tail_x: None });
        card_bottom = y + top - gap;
    }
    let fits_above = slots
        .iter()
        .zip(items)
        .all(|(slot, item)| slot.y + item.insets.0 >= area.y);
    if !fits_above {
        slots.clear();
        let mut card_top = anchor.bottom() + gap;
        for item in items {
            let (top, _, bottom, _) = item.insets;
            let y = card_top - top;
            slots.push(Slot { x: x_for(item), y, tail_x: None });
            card_top = y + item.height - bottom + gap;
        }
        return slots;
    }
    if let (Align::Pet, Some(first), Some(item)) = (align, slots.first_mut(), items.first()) {
        let (_, right, _, left) = item.insets;
        let card_width = item.width - left - right;
        // Keep the tail clear of the card's rounded corners (~28 logical px).
        let margin = (clearance * 2).min(card_width / 2);
        first.tail_x = Some((anchor_center - (first.x + left)).clamp(margin, card_width - margin));
    }
    slots
}

fn window_rect(window: &tauri::WebviewWindow<Wry>) -> Option<Rect> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(Rect {
        x: i64::from(position.x),
        y: i64::from(position.y),
        width: i64::from(size.width),
        height: i64::from(size.height),
    })
}

fn visible(app: &AppHandle<Wry>, label: &str, showing: Option<&str>) -> Option<tauri::WebviewWindow<Wry>> {
    let window = app.get_webview_window(label)?;
    (showing == Some(label) || window.is_visible().unwrap_or(false)).then_some(window)
}

/// Record that a transient notice is (re)appearing. A notice already in the
/// column keeps its slot; a new one goes on top.
pub(crate) fn note_shown(app: &AppHandle<Wry>, label: &'static str) {
    let Ok(mut order) = ORDER.lock() else { return };
    order.retain(|entry| {
        *entry == label
            || app
                .get_webview_window(entry)
                .is_some_and(|w| w.is_visible().unwrap_or(false))
    });
    if !order.contains(&label) {
        order.push(label);
    }
}

/// Re-flow every visible notice. `showing` names a window that is about to be
/// shown, so it is placed before it appears instead of jumping afterwards.
pub(crate) fn relayout(app: &AppHandle<Wry>, showing: Option<&str>) {
    let pet = visible(app, "desktop_pet", None);
    let pill = app.get_webview_window("recording_overlay");
    let mut labels: Vec<&str> = Vec::new();
    let (anchor_window, anchor, align) = if let Some(pet) = pet {
        let Some(rect) = window_rect(&pet) else { return };
        let scale = pet.scale_factor().unwrap_or(1.0);
        let top = (PET_TOP_PADDING * scale).round() as i64;
        labels.push("desktop_pet_focus");
        labels.push("recording_overlay");
        (pet, Rect { y: rect.y + top, height: rect.height - top, ..rect }, Align::Pet)
    } else if let Some(pill) = pill {
        // Hidden or not, the pill's frame is where the user expects it.
        let Some(rect) = window_rect(&pill) else { return };
        (pill, rect, Align::Center)
    } else {
        return;
    };
    let order = ORDER.lock().map(|o| o.clone()).unwrap_or_default();
    labels.extend(order.iter().copied().filter(|l| TRANSIENT.contains(l)));
    if let Some(label) = showing {
        if !labels.contains(&label) && TRANSIENT.contains(&label) {
            labels.push(label);
        }
    }
    let with_pet = align == Align::Pet;
    let windows: Vec<_> = labels
        .into_iter()
        // Without the pet, consent keeps its notification-safe corner and
        // dictation status stays in the pill rather than a second bubble.
        .filter(|label| with_pet || !matches!(*label, "consent_overlay" | "activity_bubble"))
        .filter_map(|label| visible(app, label, showing).map(|w| (label, w)))
        .collect();
    let Some(monitor) = anchor_window.current_monitor().ok().flatten()
        .or_else(|| anchor_window.primary_monitor().ok().flatten()) else { return };
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let area = Rect {
        x: i64::from(work.position.x),
        y: i64::from(work.position.y),
        width: i64::from(work.size.width),
        height: i64::from(work.size.height),
    };
    let px = |logical: f64| (logical * scale).round() as i64;
    let items: Vec<Item> = windows
        .iter()
        .filter_map(|(label, window)| {
            let rect = window_rect(window)?;
            let (t, r, b, l) = insets(label);
            Some(Item { width: rect.width, height: rect.height, beside_pet: activity_beside_pet(label), insets: (px(t), px(r), px(b), px(l)) })
        })
        .collect();
    if items.len() != windows.len() {
        return;
    }
    let slots = layout(anchor, &items, area, align, px(CARD_GAP), px(TAIL_CLEARANCE));
    for ((label, window), slot) in windows.iter().zip(&slots) {
        let current = window.outer_position().ok();
        if current.map(|p| (i64::from(p.x), i64::from(p.y))) != Some((slot.x, slot.y)) {
            let _ = window.set_position(tauri::PhysicalPosition::new(slot.x as i32, slot.y as i32));
        }
        let tail = match slot.tail_x {
            Some(x) => Tail { side: "bottom", x: (x as f64 / scale).round() },
            None => Tail { side: "none", x: 0.0 },
        };
        set_tail(app, label, tail);
    }
    debug!(target: "notice_column", with_pet, count = slots.len(), "notice column laid out");
}

fn activity_beside_pet(label: &str) -> bool {
    label == "activity_bubble"
}

fn set_tail(app: &AppHandle<Wry>, label: &str, tail: Tail) {
    let Ok(mut tails) = TAILS.lock() else { return };
    let tails = tails.get_or_insert_with(HashMap::new);
    if tails.get(label) == Some(&tail) {
        return;
    }
    tails.insert(label.to_string(), tail);
    let _ = app.emit(
        "bubble-tail",
        serde_json::json!({ "label": label, "side": tail.side, "x": tail.x }),
    );
}

/// Initial tail state for a notice window that just mounted.
#[tauri::command]
pub fn bubble_tail(window: tauri::WebviewWindow<Wry>) -> Tail {
    TAILS
        .lock()
        .ok()
        .and_then(|tails| tails.as_ref()?.get(window.label()).copied())
        .unwrap_or(Tail { side: "none", x: 0.0 })
}

/// A notice dismissing itself: hide it and close the gap it leaves.
#[tauri::command]
pub fn notice_hide(window: tauri::WebviewWindow<Wry>) {
    let _ = window.hide();
    relayout(window.app_handle(), None);
}

#[cfg(test)]
mod tests {
    use super::{activity_beside_pet, insets, layout, Align, Item, Rect};

    const AREA: Rect = Rect { x: 0, y: 24, width: 1440, height: 876 };


    fn item(width: i64, height: i64) -> Item {
        let (t, r, b, l) = insets("desktop_pet_focus");
        Item { width, height, beside_pet: false, insets: (t as i64, r as i64, b as i64, l as i64) }
    }

    #[test]
    fn wake_acknowledgment_stays_left_of_pet_without_moving_focus() {
        let pet = Rect { x: 1300, y: 764, width: 100, height: 108 };
        let focus = item(375, 280);
        let wake = Item { beside_pet: activity_beside_pet("activity_bubble"), ..item(352, 126) };
        let slots = layout(pet, &[focus, wake], AREA, Align::Pet, 10, 14);
        assert_eq!(slots[0], layout(pet, &[focus], AREA, Align::Pet, 10, 14)[0]);
        assert_eq!(slots[1].x + wake.width - wake.insets.1, pet.x - 10);
        assert!(slots[1].tail_x.is_none());
        assert!(!activity_beside_pet("desktop_pet_focus"));
    }

    #[test]
    fn recording_stays_left_of_pet_without_moving_focus_or_notices() {
        let pet = Rect { x: 1300, y: 764, width: 100, height: 108 };
        let activity = Item { beside_pet: true, ..item(352, 126) };
        let before = layout(pet, &[item(375, 280), item(372, 132)], AREA, Align::Pet, 10, 14);
        let during = layout(pet, &[item(375, 280), activity, item(372, 132)], AREA, Align::Pet, 10, 14);
        assert_eq!(during[0], before[0]);
        assert_eq!(during[2], before[1]);
        assert_eq!(during[1].x + activity.width - activity.insets.1, pet.x - 10);
        assert_eq!(during[1].y + 28 + 54 / 2, pet.y + pet.height / 2);
        assert!(during[1].tail_x.is_none());
        // The same position is used when Today's Focus is hidden.
        assert_eq!(layout(pet, &[activity], AREA, Align::Pet, 10, 14)[0], during[1]);
    }

    #[test]
    fn recording_uses_right_side_at_left_edge_and_stays_in_work_area() {
        let area = Rect { x: -1440, ..AREA };
        let pet = Rect { x: -1400, y: 24, width: 100, height: 108 };
        let activity = Item { beside_pet: true, ..item(352, 126) };
        let slot = layout(pet, &[activity], area, Align::Pet, 10, 14)[0];
        assert_eq!(slot.x + activity.insets.3, pet.right() + 10);
        assert!(slot.x >= area.x && slot.x + activity.width <= area.right());
        assert!(slot.y >= area.y && slot.y + activity.height <= area.bottom());
        assert!(slot.tail_x.is_none());
    }

    #[test]
    fn recording_tracks_pet_sizes_and_retina_scale_near_bottom_edge() {
        for scale in [1, 2] {
            for (width, height) in [(100, 108), (140, 152), (180, 196)] {
                let area = Rect { x: -1440 * scale, y: 24 * scale, width: 1440 * scale, height: 876 * scale };
                let pet = Rect { x: -200 * scale, y: (900 - height) * scale, width: width * scale, height: height * scale };
                let activity = Item {
                    width: 352 * scale, height: 126 * scale, beside_pet: true,
                    insets: (28 * scale, 32 * scale, 44 * scale, 32 * scale),
                };
                let slot = layout(pet, &[activity], area, Align::Pet, 10 * scale, 14 * scale)[0];
                assert_eq!(slot.x + activity.width - activity.insets.1, pet.x - 10 * scale);
                assert!(slot.y >= area.y && slot.y + activity.height <= area.bottom());
                assert!(slot.tail_x.is_none());
            }
        }
    }

    #[test]
    fn standalone_pill_layout_ignores_pet_only_placement() {
        let pill = Rect { x: 800, y: 790, width: 160, height: 48 };
        let activity = item(352, 126);
        assert_eq!(
            layout(pill, &[Item { beside_pet: true, ..activity }], AREA, Align::Center, 10, 14),
            layout(pill, &[activity], AREA, Align::Center, 10, 14),
        );
    }

    #[test]
    fn stacks_upward_with_equal_visible_gaps() {
        let pet = Rect { x: 1300, y: 764, width: 100, height: 108 };
        let items = [item(375, 280), item(412, 154), item(372, 132)];
        let slots = layout(pet, &items, AREA, Align::Pet, 10, 14);
        // Nearest card body ends `clearance` above the pet's head.
        assert_eq!(slots[0].y + 280 - 44, 764 - 14);
        // Every following card body ends exactly `gap` above the previous card body.
        for i in 1..items.len() {
            let below_top = slots[i - 1].y + 28;
            let this_bottom = slots[i].y + items[i].height - 44;
            assert_eq!(below_top - this_bottom, 10);
        }
        // Pet on the right half: cards share the pet's right edge.
        for (slot, it) in slots.iter().zip(&items) {
            assert_eq!(slot.x + it.width - 32, 1400);
        }
        // Only the nearest card has a tail, aimed at the pet's center.
        assert_eq!(slots[0].x + 32 + slots[0].tail_x.unwrap(), 1350);
        assert!(slots[1..].iter().all(|s| s.tail_x.is_none()));
    }

    #[test]
    fn growing_top_card_does_not_move_cards_below() {
        let pet = Rect { x: 1300, y: 764, width: 100, height: 108 };
        let short = layout(pet, &[item(375, 280), item(412, 154)], AREA, Align::Pet, 10, 14);
        let tall = layout(pet, &[item(375, 280), item(412, 270)], AREA, Align::Pet, 10, 14);
        assert_eq!(short[0], tall[0]);
        assert_eq!(short[1].y + 154, tall[1].y + 270);
    }

    #[test]
    fn pet_on_the_left_aligns_left_edges() {
        let pet = Rect { x: 40, y: 764, width: 100, height: 108 };
        let slots = layout(pet, &[item(375, 280)], AREA, Align::Pet, 10, 14);
        assert_eq!(slots[0].x + 32, 40);
    }

    #[test]
    fn centers_over_the_pill_and_clamps_to_the_display() {
        let area = Rect { x: -1440, y: 24, width: 1440, height: 876 };
        let pill = Rect { x: -800, y: 790, width: 160, height: 48 };
        let slots = layout(pill, &[item(412, 154)], area, Align::Center, 10, 14);
        assert_eq!(slots[0].x + 206, -720);
        assert!(slots[0].tail_x.is_none(), "badge notifications must have no pet pointer");
        let edge = Rect { x: -1440, y: 790, width: 160, height: 48 };
        let slots = layout(edge, &[item(412, 154)], area, Align::Center, 10, 14);
        assert_eq!(slots[0].x, -1440);
    }

    #[test]
    fn stacks_below_when_there_is_no_room_above() {
        let pet = Rect { x: 1300, y: 40, width: 100, height: 108 };
        let slots = layout(pet, &[item(375, 280), item(372, 132)], AREA, Align::Pet, 10, 14);
        assert_eq!(slots[0].y + 28, 148 + 10);
        assert_eq!(slots[1].y + 28, slots[0].y + 280 - 44 + 10);
        assert!(slots.iter().all(|s| s.tail_x.is_none()));
    }
}
