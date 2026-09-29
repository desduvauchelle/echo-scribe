//! Native click-through for the transparent paint gutters of companion notices.
//!
//! DOM pointer-events only affects the webview, not the app underneath it. Track
//! the global pointer instead: ignored windows cannot receive mouse-enter events
//! to make themselves interactive again. All AppKit calls run on the main thread.
use std::time::Duration;
use tauri::{AppHandle, Manager, Wry};

const NOTICES: [&str; 5] = [
    "desktop_pet_focus",
    "activity_bubble",
    "action_toast",
    "agent_toast",
    "meeting_start_toast",
];

/// Logical window coordinates, using the same gutters as the native layout/CSS.
/// The tail is decorative; only the card body should capture input.
fn card_contains(width: f64, height: f64, x: f64, y: f64, radius: f64, bottom_right: f64) -> bool {
    use crate::notice_column::{BUBBLE_BOTTOM, BUBBLE_SIDE, BUBBLE_TOP};
    let left = BUBBLE_SIDE;
    let right = width - BUBBLE_SIDE;
    let top = BUBBLE_TOP;
    let bottom = height - BUBBLE_BOTTOM;
    if x < left || x >= right || y < top || y >= bottom {
        return false;
    }
    // Rounded corners contain transparent pixels too.
    let r = if x > right - radius && y > bottom - radius {
        bottom_right
    } else {
        radius
    };
    let cx = x.clamp(left + r, right - r);
    let cy = y.clamp(top + r, bottom - r);
    (x - cx).powi(2) + (y - cy).powi(2) <= r * r
}

fn update(app: &AppHandle<Wry>) -> bool {
    let Ok(pointer) = app.cursor_position() else {
        return true;
    };
    let mut any_visible = false;
    for label in NOTICES {
        let Some(window) = app
            .get_webview_window(label)
            .filter(|w| w.is_visible().unwrap_or(false))
        else {
            continue;
        };
        any_visible = true;
        let (Ok(origin), Ok(size), Ok(scale)) = (
            window.inner_position(),
            window.inner_size(),
            window.scale_factor(),
        ) else {
            continue;
        };
        let radius = if label == "activity_bubble" {
            16.0
        } else {
            17.0
        };
        let tail = crate::notice_column::bubble_tail(window.clone());
        let bottom_right = if tail.has_tail() { 5.0 } else { radius };
        let ignore = !card_contains(
            f64::from(size.width) / scale,
            f64::from(size.height) / scale,
            (pointer.x - f64::from(origin.x)) / scale,
            (pointer.y - f64::from(origin.y)) / scale,
            radius,
            bottom_right,
        );
        // Reapply to the actual window: the focus window can be destroyed and
        // recreated with the same label between ticks.
        let _ = window.set_ignore_cursor_events(ignore);
    }
    any_visible
}

/// One app-lifetime tracker, independent of notice creation/destruction. Awaiting
/// each main-thread pass prevents a backlog if the UI thread is temporarily busy.
pub(crate) fn start(app: AppHandle<Wry>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let (send, receive) = tokio::sync::oneshot::channel();
            let handle = app.clone();
            if app
                .run_on_main_thread(move || {
                    let visible = update(&handle);
                    let _ = send.send(visible);
                })
                .is_err()
            {
                break;
            }
            let Ok(visible) = receive.await else { break };
            tokio::time::sleep(Duration::from_millis(if visible { 16 } else { 100 })).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::card_contains;

    #[test]
    fn shadow_gutters_and_decorative_tail_pass_through() {
        for (x, y) in [
            (10., 100.),
            (365., 100.),
            (150., 10.),
            (150., 260.),
            (320., 244.),
        ] {
            assert!(!card_contains(375., 280., x, y, 17., 5.), "{x}, {y}");
        }
    }

    #[test]
    fn card_content_close_button_and_scrollbar_stay_interactive() {
        for (x, y) in [(60., 70.), (320., 45.), (337., 120.), (150., 230.)] {
            assert!(card_contains(375., 280., x, y, 17., 5.), "{x}, {y}");
        }
    }

    #[test]
    fn transparent_rounded_corners_pass_through() {
        assert!(!card_contains(375., 280., 33., 29., 17., 5.));
        assert!(!card_contains(375., 280., 342., 235., 17., 5.));
        assert!(card_contains(375., 280., 339., 232., 17., 5.));
        assert!(!card_contains(375., 280., 339., 232., 17., 17.));
    }

    #[test]
    fn resized_card_uses_current_bounds() {
        assert!(!card_contains(412., 154., 100., 200., 17., 5.));
        assert!(card_contains(412., 300., 100., 200., 17., 5.));
    }
}
