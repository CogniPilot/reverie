//! Interpret the console's normalized provider quota readings.
//!
//! Missing, stale, or elapsed windows cannot authorize more work. Only a
//! fresh provider observation can establish capacity after a reset.

#[derive(Clone, Copy)]
pub enum WindowReading {
    Absent,
    Malformed,
    Fields {
        used_percent: Option<f64>,
        reset_ms: Option<f64>,
    },
}

#[derive(Clone, Copy)]
pub enum WindowName {
    FiveHour,
    SevenDay,
}

impl WindowName {
    pub const ORDERED: [Self; 2] = [Self::FiveHour, Self::SevenDay];

    pub fn key(self) -> &'static str {
        match self {
            Self::FiveHour => "fiveHour",
            Self::SevenDay => "sevenDay",
        }
    }
}

pub struct Reading {
    pub ready: bool,
    pub updated_ms: Option<f64>,
    pub windows: Option<[WindowReading; 2]>,
}

pub struct Limits {
    pub now: f64,
    pub reserve_percent: f64,
    pub max_age_seconds: f64,
}

pub struct Window {
    pub name: WindowName,
    pub used_percent: f64,
    /// Provider reset time in Unix seconds.
    pub reset_at: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Unavailable,
    Stale,
    MalformedWindow,
    InvalidWindow,
    ElapsedReset,
}

pub struct Capacity {
    pub next_reset: f64,
    pub retry_at: Option<f64>,
}

pub struct Assessment {
    pub windows: Vec<Window>,
    pub result: Result<Capacity, Refusal>,
}

impl Assessment {
    pub fn available(&self) -> bool {
        self.result
            .as_ref()
            .is_ok_and(|capacity| capacity.retry_at.is_none())
    }
}

pub fn assess(reading: Reading, limits: &Limits) -> Assessment {
    let mut windows = Vec::new();
    let result = assess_windows(reading, limits, &mut windows);
    Assessment { windows, result }
}

fn assess_windows(
    input: Reading,
    limits: &Limits,
    windows: &mut Vec<Window>,
) -> Result<Capacity, Refusal> {
    let readings = input
        .windows
        .filter(|_| input.ready)
        .ok_or(Refusal::Unavailable)?;
    let age = limits.now - input.updated_ms.ok_or(Refusal::Stale)? / 1000.0;
    if !(0.0..=limits.max_age_seconds).contains(&age) {
        return Err(Refusal::Stale);
    }
    let ceiling = 100.0 - limits.reserve_percent;
    let mut next_reset = None::<f64>;
    let mut retry_at = None::<f64>;
    for (name, reading) in WindowName::ORDERED.into_iter().zip(readings) {
        let Some(window) = window(name, reading)? else {
            continue;
        };
        let reset = window.reset_at;
        let reached_reserve = window.used_percent >= ceiling;
        windows.push(window);
        if reset <= limits.now {
            return Err(Refusal::ElapsedReset);
        }
        next_reset = Some(next_reset.map_or(reset, |current| current.min(reset)));
        if reached_reserve {
            retry_at = Some(retry_at.map_or(reset, |current| current.max(reset)));
        }
    }
    Ok(Capacity {
        next_reset: next_reset.ok_or(Refusal::Unavailable)?,
        retry_at,
    })
}

fn window(name: WindowName, reading: WindowReading) -> Result<Option<Window>, Refusal> {
    let (used, reset) = match reading {
        WindowReading::Absent => return Ok(None),
        WindowReading::Malformed => return Err(Refusal::MalformedWindow),
        WindowReading::Fields {
            used_percent,
            reset_ms,
        } => (used_percent, reset_ms),
    };
    let finite = |value: Option<f64>| {
        value
            .filter(|value| value.is_finite())
            .ok_or(Refusal::InvalidWindow)
    };
    Ok(Some(Window {
        name,
        used_percent: finite(used)?,
        reset_at: finite(reset)? / 1000.0,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(used: f64, reset: f64) -> WindowReading {
        WindowReading::Fields {
            used_percent: Some(used),
            reset_ms: Some(reset * 1000.0),
        }
    }

    fn reading(updated: f64, windows: [WindowReading; 2]) -> Reading {
        Reading {
            ready: true,
            updated_ms: Some(updated * 1000.0),
            windows: Some(windows),
        }
    }

    fn limits(now: f64) -> Limits {
        Limits {
            now,
            reserve_percent: 5.0,
            max_age_seconds: 600.0,
        }
    }

    #[test]
    fn reserve_considers_both_windows_and_reset_alone_never_reopens() {
        let windows = [fields(95.0, 1100.0), fields(99.0, 2000.0)];
        let assessment = assess(reading(1000.0, windows), &limits(1000.0));
        assert!(!assessment.available());
        let capacity = assessment.result.ok().unwrap();
        assert_eq!(capacity.next_reset, 1100.0);
        assert_eq!(capacity.retry_at, Some(2000.0));
        let elapsed = assess(reading(1200.0, windows), &limits(1200.0));
        assert_eq!(elapsed.result.err(), Some(Refusal::ElapsedReset));
        assert_eq!(elapsed.windows.len(), 1);
        let reset = [fields(0.0, 1600.0), fields(0.0, 3000.0)];
        assert!(assess(reading(1200.0, reset), &limits(1200.0)).available());
    }

    #[test]
    fn future_stale_missing_and_malformed_readings_are_closed() {
        let partial = [fields(0.0, 1100.0), WindowReading::Absent];
        assert!(assess(reading(400.0, partial), &limits(1000.0)).available());
        for updated in [399.0, 1000.001, f64::NAN] {
            assert_eq!(
                assess(reading(updated, partial), &limits(1000.0))
                    .result
                    .err(),
                Some(Refusal::Stale)
            );
        }
        let missing = [WindowReading::Absent; 2];
        assert_eq!(
            assess(reading(1000.0, missing), &limits(1000.0))
                .result
                .err(),
            Some(Refusal::Unavailable)
        );
        let malformed = [partial[0], WindowReading::Malformed];
        assert_eq!(
            assess(reading(1000.0, malformed), &limits(1000.0))
                .result
                .err(),
            Some(Refusal::MalformedWindow)
        );
        let invalid = [partial[0], fields(f64::INFINITY, 2000.0)];
        let partial = assess(reading(1000.0, invalid), &limits(1000.0));
        assert_eq!(partial.result.err(), Some(Refusal::InvalidWindow));
        assert_eq!(partial.windows.len(), 1);
    }
}
