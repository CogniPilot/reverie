use jiff::{Timestamp, Zoned, tz::TimeZone};
use reverie_time_zone::load_zone;
use serde_json::Value;

pub(super) struct Clock {
    now: Timestamp,
    zone: TimeZone,
}

fn timestamp(seconds: f64) -> Result<Timestamp, &'static str> {
    if !seconds.is_finite() {
        return Err("invalid Hands prompt time");
    }
    Timestamp::from_microsecond((seconds * 1_000_000.0).round_ties_even() as i64)
        .map_err(|_| "invalid Hands prompt time")
}

pub(super) fn zone_name(value: &Value) -> Option<&str> {
    value.as_str().filter(|key| key.len() <= 100)
}

impl Clock {
    pub(super) fn new(
        fallback: &str,
        reported: Option<&Value>,
        now: f64,
    ) -> Result<Self, &'static str> {
        let zone = reported
            .and_then(zone_name)
            .and_then(load_zone)
            .or_else(|| load_zone(fallback))
            .ok_or("config: timezone is not a known time zone")?;
        Ok(Self {
            now: timestamp(now)?,
            zone,
        })
    }

    pub(super) fn now(&self) -> String {
        let local = self.now.to_zoned(self.zone.clone());
        let utc = self.now.to_zoned(TimeZone::UTC);
        format!(
            "Now: {} {} ({} UTC).",
            local.strftime("%A %Y-%m-%d"),
            display_time(&local),
            utc.strftime("%H:%M"),
        )
    }

    pub(super) fn message(&self, milliseconds: f64) -> Result<Option<String>, &'static str> {
        if milliseconds <= 0.0 {
            return Ok(None);
        }
        let local = timestamp(milliseconds / 1000.0)?.to_zoned(self.zone.clone());
        Ok(Some(display_time(&local)))
    }
}

fn display_time(local: &Zoned) -> String {
    let hour = (local.hour() + 11) % 12 + 1;
    format!("{hour}:{}", local.strftime("%M %p %Z"))
}

pub(super) fn elapsed(milliseconds: f64, now: f64) -> Option<String> {
    if milliseconds <= 0.0 {
        return None;
    }
    let seconds = now - milliseconds / 1000.0;
    let elapsed = if seconds < 60.0 {
        "just now".into()
    } else if seconds < 3600.0 {
        format!("{}m ago", (seconds / 60.0).floor() as u64)
    } else if seconds < 86_400.0 {
        format!("{}h ago", (seconds / 3600.0).floor() as u64)
    } else {
        format!("{}d ago", (seconds / 86_400.0).floor() as u64)
    };
    Some(elapsed)
}
