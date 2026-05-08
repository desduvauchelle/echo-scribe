//! Strict allowlist of known meeting-URL patterns. Used by the auto-detector
//! to decide whether a browser-frontmost event should be treated as a real
//! meeting (vs. any-tab-with-mic-active false trigger).
//!
//! Returns the user-facing provider name on match, `None` otherwise.

use url::Url;

/// Returns the meeting provider's display name if `raw` matches a known
/// meeting URL pattern, otherwise `None`.
pub fn classify(raw: &str) -> Option<&'static str> {
    let url = Url::parse(raw).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let path = url.path();

    // Google Meet: meet.google.com/<3>-<4>-<3> (the meeting code format).
    if host == "meet.google.com" {
        let p = path.trim_start_matches('/');
        let first = p.split('/').next().unwrap_or("");
        if is_meet_code(first) {
            return Some("Google Meet");
        }
        return None;
    }

    // Zoom (web client / join links): *.zoom.us/{j,wc,my}/...
    if host == "zoom.us" || host.ends_with(".zoom.us") {
        if path.starts_with("/j/") || path.starts_with("/wc/") || path.starts_with("/my/") {
            return Some("Zoom");
        }
        return None;
    }

    // Microsoft Teams (web): teams.microsoft.com or teams.live.com.
    if host == "teams.microsoft.com" {
        if path.starts_with("/l/meetup-join/")
            || path.starts_with("/_#/conv/")
            || path.starts_with("/v2/")
        {
            return Some("Microsoft Teams");
        }
        return None;
    }
    if host == "teams.live.com" && path.starts_with("/meet/") {
        return Some("Microsoft Teams");
    }

    // Slack huddles / calls.
    if host == "app.slack.com" && path.starts_with("/huddle/") {
        return Some("Slack Huddle");
    }
    if (host == "slack.com" || host.ends_with(".slack.com")) && path.starts_with("/calls/") {
        return Some("Slack Call");
    }

    // Whereby room URLs — exclude marketing/account paths.
    if host == "whereby.com" {
        const NON_ROOMS: &[&str] =
            &["/", "/information", "/pricing", "/about", "/login", "/signup"];
        if !NON_ROOMS.iter().any(|p| path == *p || path.starts_with(&format!("{p}/"))) {
            if path.len() > 1 {
                return Some("Whereby");
            }
        }
        return None;
    }

    // Webex: *.webex.com/meet/... or /wbxmjs/joinservice/...
    if host == "webex.com" || host.ends_with(".webex.com") {
        if path.contains("/meet/") || path.contains("/wbxmjs/joinservice/") {
            return Some("Webex");
        }
        return None;
    }

    // Around: around.co/r/<room>
    if host == "around.co" && path.starts_with("/r/") {
        return Some("Around");
    }

    // Gather: app.gather.town/app/... or gather.town/app/...
    if (host == "app.gather.town" || host == "gather.town") && path.starts_with("/app/") {
        return Some("Gather");
    }

    // Jitsi: meet.jit.si/<non-empty>
    if host == "meet.jit.si" && path.len() > 1 {
        return Some("Jitsi");
    }

    // Huddle01: huddle01.app/<non-empty>
    if host == "huddle01.app" && path.len() > 1 {
        return Some("Huddle01");
    }

    None
}

/// True for Google-Meet-style codes like "abc-defg-hij" (3-4-3 lowercase letters).
fn is_meet_code(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 3 {
        return false;
    }
    let lens = [3, 4, 3];
    for (i, p) in parts.iter().enumerate() {
        if p.len() != lens[i] {
            return false;
        }
        if !p.bytes().all(|b| b.is_ascii_lowercase()) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_meet_room_matches() {
        assert_eq!(classify("https://meet.google.com/abc-defg-hij"), Some("Google Meet"));
        assert_eq!(
            classify("https://meet.google.com/abc-defg-hij?authuser=0"),
            Some("Google Meet")
        );
    }

    #[test]
    fn google_meet_marketing_does_not_match() {
        assert_eq!(classify("https://meet.google.com/about"), None);
        assert_eq!(classify("https://meet.google.com/"), None);
        assert_eq!(classify("https://meet.google.com/landing"), None);
    }

    #[test]
    fn zoom_join_links_match() {
        assert_eq!(classify("https://zoom.us/j/1234567890"), Some("Zoom"));
        assert_eq!(
            classify("https://us02web.zoom.us/j/1234567890?pwd=foo"),
            Some("Zoom")
        );
        assert_eq!(classify("https://zoom.us/wc/1234567890/join"), Some("Zoom"));
        assert_eq!(classify("https://zoom.us/my/myroom"), Some("Zoom"));
    }

    #[test]
    fn zoom_homepage_does_not_match() {
        assert_eq!(classify("https://zoom.us/"), None);
        assert_eq!(classify("https://zoom.us/pricing"), None);
        assert_eq!(classify("https://us02web.zoom.us/account"), None);
    }

    #[test]
    fn teams_meetup_join_matches() {
        assert_eq!(
            classify("https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0"),
            Some("Microsoft Teams")
        );
        assert_eq!(
            classify("https://teams.live.com/meet/9999999999"),
            Some("Microsoft Teams")
        );
        assert_eq!(
            classify("https://teams.microsoft.com/v2/?meetingjoin=true"),
            Some("Microsoft Teams")
        );
    }

    #[test]
    fn teams_root_does_not_match() {
        assert_eq!(classify("https://teams.microsoft.com/"), None);
        assert_eq!(classify("https://teams.microsoft.com/_#/files"), None);
    }

    #[test]
    fn slack_huddle_matches() {
        assert_eq!(
            classify("https://app.slack.com/huddle/T123/C456"),
            Some("Slack Huddle")
        );
        assert_eq!(
            classify("https://acme.slack.com/calls/abc"),
            Some("Slack Call")
        );
    }

    #[test]
    fn slack_marketing_does_not_match() {
        assert_eq!(classify("https://slack.com/intl/en-gb/"), None);
        assert_eq!(classify("https://app.slack.com/client/T123"), None);
    }

    #[test]
    fn whereby_room_matches_marketing_does_not() {
        assert_eq!(classify("https://whereby.com/my-room"), Some("Whereby"));
        assert_eq!(classify("https://whereby.com/"), None);
        assert_eq!(classify("https://whereby.com/information"), None);
        assert_eq!(classify("https://whereby.com/pricing"), None);
    }

    #[test]
    fn webex_meet_matches() {
        assert_eq!(
            classify("https://acme.webex.com/meet/john"),
            Some("Webex")
        );
        assert_eq!(
            classify("https://acme.webex.com/wbxmjs/joinservice/sites/acme/meeting/12345"),
            Some("Webex")
        );
    }

    #[test]
    fn webex_homepage_does_not_match() {
        assert_eq!(classify("https://www.webex.com/"), None);
    }

    #[test]
    fn around_room_matches() {
        assert_eq!(classify("https://around.co/r/abcd-efgh"), Some("Around"));
        assert_eq!(classify("https://around.co/"), None);
    }

    #[test]
    fn gather_room_matches() {
        assert_eq!(
            classify("https://app.gather.town/app/abc/MyRoom"),
            Some("Gather")
        );
        assert_eq!(classify("https://gather.town/"), None);
    }

    #[test]
    fn jitsi_room_matches() {
        assert_eq!(classify("https://meet.jit.si/MyMeetingName"), Some("Jitsi"));
        assert_eq!(classify("https://meet.jit.si/"), None);
    }

    #[test]
    fn huddle01_room_matches() {
        assert_eq!(classify("https://huddle01.app/room/abc"), Some("Huddle01"));
        assert_eq!(classify("https://huddle01.app/"), None);
    }

    #[test]
    fn unknown_hosts_do_not_match() {
        assert_eq!(classify("https://news.ycombinator.com"), None);
        assert_eq!(classify("https://github.com/anthropics/anthropic-sdk-python"), None);
        assert_eq!(classify("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), None);
    }

    #[test]
    fn malformed_urls_return_none() {
        assert_eq!(classify("not a url"), None);
        assert_eq!(classify(""), None);
        assert_eq!(classify("javascript:void(0)"), None);
    }
}
