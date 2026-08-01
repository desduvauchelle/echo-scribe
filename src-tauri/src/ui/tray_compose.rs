//! Pixel compositing for the dynamic menu bar icon.
//!
//! The tray icon is the Echo Scribe bars logo plus up to two corner badges:
//! an activity badge (bottom-right — what the app is doing right now) and a
//! keep-awake badge (top-right — a power assertion is held). The badge PNGs
//! live in `resources/` and are rendered from the SVG sources in
//! `scripts/tray-icons/` (see `generate.sh` there); the knockout constants
//! below must match the disc geometry in those SVGs.

use crate::coordinator::TrayPipelineState;

/// All tray assets are 64x64 RGBA.
pub const ICON_SIZE: u32 = 64;

/// (cx, cy, radius) of the hole punched into the base logo under a badge.
/// Radius = badge disc radius + 3px separation ring.
pub const ACTIVITY_KNOCKOUT: (f32, f32, f32) = (47.0, 47.0, 18.0);
pub const AWAKE_KNOCKOUT: (f32, f32, f32) = (49.0, 15.0, 15.0);

/// The one activity the bottom-right badge shows. Mutually exclusive by
/// design — a 16pt icon can only carry one activity legibly, so concurrent
/// activities resolve by priority (see [`activity_for`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    ScreenRecording,
    Dictation,
    Transcribing,
    Thinking,
    Meeting,
}

impl Activity {
    pub fn badge_resource(self) -> &'static str {
        match self {
            Activity::ScreenRecording => "resources/tray_badge_screenrec.png",
            Activity::Dictation => "resources/tray_badge_dictation.png",
            Activity::Transcribing => "resources/tray_badge_transcribing.png",
            Activity::Thinking => "resources/tray_badge_thinking.png",
            Activity::Meeting => "resources/tray_badge_meeting.png",
        }
    }
}

/// Resolve which activity badge to show. Screen recording wins over the
/// dictation pipeline (a dictation cycle ending must not clear the red
/// recording badge), the pipeline wins over the long-running meeting badge
/// (a dictation during a meeting shows the mic, then falls back to the
/// meeting badge). Paused hotkeys mute only the pipeline's contribution —
/// screen recording and meetings keep running while paused.
pub fn activity_for(
    pipeline: TrayPipelineState,
    screenrec: bool,
    meeting: bool,
    paused: bool,
) -> Option<Activity> {
    if screenrec {
        return Some(Activity::ScreenRecording);
    }
    let pipeline = if paused {
        TrayPipelineState::Idle
    } else {
        pipeline
    };
    match pipeline {
        TrayPipelineState::Recording => Some(Activity::Dictation),
        TrayPipelineState::Transcribing => Some(Activity::Transcribing),
        TrayPipelineState::Thinking => Some(Activity::Thinking),
        TrayPipelineState::Idle => {
            if meeting {
                Some(Activity::Meeting)
            } else {
                None
            }
        }
    }
}

/// Clear the base logo's alpha inside a badge's knockout disc, with a 1px
/// feathered edge so the ring stays anti-aliased.
pub fn punch(rgba: &mut [u8], width: u32, knockout: (f32, f32, f32)) {
    let (cx, cy, r) = knockout;
    let height = rgba.len() as u32 / 4 / width;
    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let d = (dx * dx + dy * dy).sqrt() - r;
            if d < 1.0 {
                let i = ((y * width + x) * 4 + 3) as usize;
                if d <= 0.0 {
                    rgba[i] = 0;
                } else {
                    rgba[i] = (rgba[i] as f32 * d) as u8;
                }
            }
        }
    }
}

/// Straight-alpha src-over of `top` onto `base` (same dimensions).
pub fn over(base: &mut [u8], top: &[u8]) {
    for (b, t) in base.chunks_exact_mut(4).zip(top.chunks_exact(4)) {
        let sa = t[3] as u32;
        if sa == 0 {
            continue;
        }
        let da = b[3] as u32;
        let oa = sa + da * (255 - sa) / 255;
        if oa == 0 {
            continue;
        }
        for c in 0..3 {
            b[c] = ((t[c] as u32 * sa + b[c] as u32 * da * (255 - sa) / 255) / oa) as u8;
        }
        b[3] = oa as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenrec_beats_everything() {
        assert_eq!(
            activity_for(TrayPipelineState::Recording, true, true, false),
            Some(Activity::ScreenRecording)
        );
        // ...even paused hotkeys don't hide a live screen recording.
        assert_eq!(
            activity_for(TrayPipelineState::Idle, true, false, true),
            Some(Activity::ScreenRecording)
        );
    }

    #[test]
    fn pipeline_beats_meeting_and_falls_back_to_it() {
        assert_eq!(
            activity_for(TrayPipelineState::Recording, false, true, false),
            Some(Activity::Dictation)
        );
        assert_eq!(
            activity_for(TrayPipelineState::Idle, false, true, false),
            Some(Activity::Meeting)
        );
    }

    #[test]
    fn paused_mutes_only_the_pipeline() {
        assert_eq!(
            activity_for(TrayPipelineState::Transcribing, false, false, true),
            None
        );
        assert_eq!(
            activity_for(TrayPipelineState::Transcribing, false, true, true),
            Some(Activity::Meeting)
        );
    }

    #[test]
    fn idle_without_flags_has_no_badge() {
        assert_eq!(
            activity_for(TrayPipelineState::Idle, false, false, false),
            None
        );
    }

    #[test]
    fn punch_clears_disc_and_keeps_outside() {
        let w = 64u32;
        let mut px = vec![255u8; (w * w * 4) as usize];
        punch(&mut px, w, ACTIVITY_KNOCKOUT);
        let alpha = |x: u32, y: u32| px[((y * w + x) * 4 + 3) as usize];
        assert_eq!(alpha(47, 47), 0, "badge center must be cleared");
        assert_eq!(alpha(2, 2), 255, "far corner must be untouched");
    }

    #[test]
    fn over_blends_opaque_top_wins() {
        let mut base = vec![10u8, 20, 30, 255];
        let top = vec![200u8, 100, 50, 255];
        over(&mut base, &top);
        assert_eq!(base, vec![200, 100, 50, 255]);

        // Fully transparent top leaves the base untouched.
        let mut base = vec![10u8, 20, 30, 128];
        over(&mut base, &[0, 0, 0, 0]);
        assert_eq!(base, vec![10, 20, 30, 128]);
    }
}
