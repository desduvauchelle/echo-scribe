//! Scheduler: when to fire, which dates to backfill.

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, Weekday};

/// Settings snapshot passed in to keep the scheduler pure and testable.
#[derive(Debug, Clone, Copy)]
pub struct ScheduleSettings {
    pub enabled: bool,
    pub deliver_hour: u8,
    pub include_weekends: bool,
}

/// Return the next wall-clock instant (local) at which the scheduler should
/// fire. If today's fire time is still in the future, returns today; otherwise
/// returns tomorrow at the same time.
///
/// When weekends are excluded, fire times that would land on Saturday or
/// Sunday are advanced to the following Monday.
///
/// Computed in local-wall-clock terms via `NaiveDateTime` so it stays
/// deterministic in tests. The live caller will use
/// `chrono::Local::now().naive_local()`.
pub fn next_fire_time(
    now: NaiveDateTime,
    settings: ScheduleSettings,
) -> Option<NaiveDateTime> {
    if !settings.enabled {
        return None;
    }
    let hour = settings.deliver_hour.min(23) as u32;
    let fire_time = NaiveTime::from_hms_opt(hour, 0, 0)?;
    let mut candidate = NaiveDateTime::new(now.date(), fire_time);
    if candidate <= now {
        candidate += Duration::days(1);
    }
    if !settings.include_weekends {
        while matches!(candidate.weekday(), Weekday::Sat | Weekday::Sun) {
            candidate += Duration::days(1);
        }
    }
    Some(candidate)
}

/// Return the list of dates (oldest first) for which the scheduler should
/// attempt generation, given the current local date and a set of dates that
/// already have a row. Always covers `today - 1` and walks back up to
/// `lookback_days` to find missing days. Excludes weekend dates if weekends
/// are off.
pub fn dates_needing_generation(
    today: NaiveDate,
    existing_dates: &[String],
    lookback_days: u32,
    include_weekends: bool,
) -> Vec<String> {
    let mut out = Vec::new();
    let existing: std::collections::HashSet<&str> =
        existing_dates.iter().map(|s| s.as_str()).collect();
    for delta in 1..=lookback_days as i64 {
        let candidate = today - Duration::days(delta);
        if !include_weekends
            && matches!(candidate.weekday(), Weekday::Sat | Weekday::Sun)
        {
            continue;
        }
        let s = candidate.format("%Y-%m-%d").to_string();
        if !existing.contains(s.as_str()) {
            out.push(s);
        }
    }
    out.reverse(); // chronological (oldest first)
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn settings(hour: u8, weekends: bool) -> ScheduleSettings {
        ScheduleSettings {
            enabled: true,
            deliver_hour: hour,
            include_weekends: weekends,
        }
    }

    fn ndt(y: i32, m: u32, d: u32, h: u32, mi: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(h, mi, 0)
            .unwrap()
    }

    #[test]
    fn fire_today_when_before_hour() {
        // 2026-05-13 is a Wednesday
        let now = ndt(2026, 5, 13, 6, 0);
        let next = next_fire_time(now, settings(8, true)).unwrap();
        assert_eq!(next, ndt(2026, 5, 13, 8, 0));
    }

    #[test]
    fn fire_tomorrow_when_after_hour() {
        let now = ndt(2026, 5, 13, 9, 0);
        let next = next_fire_time(now, settings(8, true)).unwrap();
        assert_eq!(next, ndt(2026, 5, 14, 8, 0));
    }

    #[test]
    fn skip_to_monday_when_weekends_off() {
        // Friday 2026-05-15 at 9am → next would be Saturday 8am → skip to
        // Monday 2026-05-18.
        let now = ndt(2026, 5, 15, 9, 0);
        let next = next_fire_time(now, settings(8, false)).unwrap();
        assert_eq!(next, ndt(2026, 5, 18, 8, 0));
    }

    #[test]
    fn weekends_on_fires_saturday() {
        let now = ndt(2026, 5, 15, 9, 0);
        let next = next_fire_time(now, settings(8, true)).unwrap();
        assert_eq!(next, ndt(2026, 5, 16, 8, 0));
    }

    #[test]
    fn disabled_returns_none() {
        let now = ndt(2026, 5, 13, 6, 0);
        let s = ScheduleSettings {
            enabled: false,
            deliver_hour: 8,
            include_weekends: true,
        };
        assert!(next_fire_time(now, s).is_none());
    }

    #[test]
    fn backfill_returns_full_lookback_when_no_rows_exist() {
        let today = NaiveDate::from_ymd_opt(2026, 5, 13).unwrap();
        let dates = dates_needing_generation(today, &[], 7, true);
        assert_eq!(dates.first().map(|s| s.as_str()), Some("2026-05-06"));
        assert_eq!(dates.last().map(|s| s.as_str()), Some("2026-05-12"));
        assert_eq!(dates.len(), 7);
    }

    #[test]
    fn backfill_skips_existing_dates() {
        let today = NaiveDate::from_ymd_opt(2026, 5, 13).unwrap();
        let existing = vec!["2026-05-10".to_string(), "2026-05-12".to_string()];
        let dates = dates_needing_generation(today, &existing, 7, true);
        assert!(!dates.contains(&"2026-05-10".to_string()));
        assert!(!dates.contains(&"2026-05-12".to_string()));
        assert_eq!(dates.len(), 5);
    }

    #[test]
    fn backfill_skips_weekends_when_off() {
        // 2026-05-13 (Wed). Lookback 7 days includes Sat 2026-05-09 and Sun 2026-05-10.
        let today = NaiveDate::from_ymd_opt(2026, 5, 13).unwrap();
        let dates = dates_needing_generation(today, &[], 7, false);
        assert!(!dates.contains(&"2026-05-09".to_string()));
        assert!(!dates.contains(&"2026-05-10".to_string()));
    }
}
