//! Rule-based temporal intent extraction.
//!
//! Parses phrases like "today", "yesterday", "this week" from a user message
//! and returns an ISO-8601 date window `(from, to)` suitable for SQL queries
//! against `captured_at`.

use crate::db::items::format_iso_utc;

/// Parse temporal keywords from `message` and return an ISO-8601 `(from, to)` window.
/// `now_secs` is seconds since Unix epoch (UTC).
/// Returns `None` if no recognized temporal phrase is found.
pub fn extract_date_window(message: &str, now_secs: i64) -> Option<(String, String)> {
    let lower = message.to_lowercase();

    let today_start = (now_secs / 86_400) * 86_400;
    let days_since_epoch = now_secs / 86_400;
    // weekday_mon0: 0=Mon … 6=Sun. Epoch (1970-01-01) was Thursday = 3.
    let weekday_mon0 = ((days_since_epoch + 3) % 7) as i64;

    if lower.contains("yesterday") {
        let from = today_start - 86_400;
        let to = today_start - 1;
        return Some((format_iso_utc(from), format_iso_utc(to)));
    }

    if lower.contains("last week") {
        let this_monday = today_start - weekday_mon0 * 86_400;
        let from = this_monday - 7 * 86_400;
        let to = this_monday - 1;
        return Some((format_iso_utc(from), format_iso_utc(to)));
    }

    if lower.contains("this week") {
        let from = today_start - weekday_mon0 * 86_400;
        return Some((format_iso_utc(from), format_iso_utc(now_secs)));
    }

    if lower.contains("last month") {
        let (y, m, _) = civil_from_days(days_since_epoch);
        let (from_y, from_m) = if m == 1 { (y - 1, 12u32) } else { (y, m - 1) };
        let days_in_from_m = days_in_month(from_y, from_m);
        let from = days_to_epoch(from_y, from_m, 1) * 86_400;
        let to = days_to_epoch(from_y, from_m, days_in_from_m) * 86_400 + 86_399;
        return Some((format_iso_utc(from), format_iso_utc(to)));
    }

    if lower.contains("this month") {
        let (y, m, _) = civil_from_days(days_since_epoch);
        let from = days_to_epoch(y, m, 1) * 86_400;
        return Some((format_iso_utc(from), format_iso_utc(now_secs)));
    }

    if lower.contains("today") {
        return Some((format_iso_utc(today_start), format_iso_utc(now_secs)));
    }

    None
}

/// Civil date (year, month 1-12, day 1-31) from days since Unix epoch.
/// Uses Howard Hinnant's algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Days since Unix epoch for the start of a given UTC date.
fn days_to_epoch(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let m = month as i64;
    let d = day as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Days in a given month, accounting for leap years.
fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-05-02 12:00:00 UTC
    // days since epoch: 2026-05-02 = day 20575
    // 20575 * 86400 + 43200 = 1_777_723_200
    const SAMPLE_NOW: i64 = 1_777_723_200;

    #[test]
    fn today_window() {
        let w = extract_date_window("what did I do today", SAMPLE_NOW).unwrap();
        assert_eq!(w.0, "2026-05-02T00:00:00Z");
        assert_eq!(w.1, "2026-05-02T12:00:00Z");
    }

    #[test]
    fn yesterday_window() {
        let w = extract_date_window("everything I captured yesterday", SAMPLE_NOW).unwrap();
        assert_eq!(w.0, "2026-05-01T00:00:00Z");
        assert_eq!(w.1, "2026-05-01T23:59:59Z");
    }

    #[test]
    fn this_week_window() {
        // 2026-05-02 is a Saturday. Monday of this week = 2026-04-27.
        let w = extract_date_window("what happened this week", SAMPLE_NOW).unwrap();
        assert_eq!(w.0, "2026-04-27T00:00:00Z");
        assert_eq!(w.1, "2026-05-02T12:00:00Z");
    }

    #[test]
    fn last_week_window() {
        // Last week Mon=2026-04-20, Sun end=2026-04-26T23:59:59Z
        let w = extract_date_window("tasks from last week", SAMPLE_NOW).unwrap();
        assert_eq!(w.0, "2026-04-20T00:00:00Z");
        assert_eq!(w.1, "2026-04-26T23:59:59Z");
    }

    #[test]
    fn this_month_window() {
        let w = extract_date_window("my captures this month", SAMPLE_NOW).unwrap();
        assert_eq!(w.0, "2026-05-01T00:00:00Z");
        assert_eq!(w.1, "2026-05-02T12:00:00Z");
    }

    #[test]
    fn last_month_window() {
        let w = extract_date_window("blocked items last month", SAMPLE_NOW).unwrap();
        assert_eq!(w.0, "2026-04-01T00:00:00Z");
        assert_eq!(w.1, "2026-04-30T23:59:59Z");
    }

    #[test]
    fn no_temporal_keyword_returns_none() {
        assert!(extract_date_window("what is a project", SAMPLE_NOW).is_none());
        assert!(extract_date_window("help me write a summary", SAMPLE_NOW).is_none());
    }

    #[test]
    fn case_insensitive() {
        assert!(extract_date_window("What Did I Do TODAY", SAMPLE_NOW).is_some());
    }
}
