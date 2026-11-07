//! The broker watchdog, the legacy `supervise()` loop: every 2 s it probes the
//! Office API, stops every laptop after 10 minutes offline, and sweeps detached
//! laptops. The Office half keeps the legacy retry-next-tick handling exactly.
//! The sweep keeps the same actions and retries, and additionally records each
//! failed step per session in fixed bounded state, shown by status; the legacy
//! loop discarded those failures.
#[cfg(test)]
mod tests;
use reverie_contracts::broker_reply::BrokerReply;
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

/// The legacy `OFFLINE_GRACE_SECONDS`.
pub const OFFLINE_GRACE_SECONDS: f64 = 600.0;
const TICK: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(20);
/// At most this many codes are kept for one session.
pub const CODES_PER_SESSION: usize = 4;

/// One step of the detached-laptop sweep that can fail.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum SweepStep {
    /// Reading the laptop's runtime record or its exit marker.
    RuntimeRecord,
    /// The company admission check for the session.
    Admission,
    Stop,
    Inspect,
    /// Releasing storage, unregistering and closing the Office phone.
    Retire,
}
impl SweepStep {
    pub fn code(self) -> &'static str {
        match self {
            Self::RuntimeRecord => "RUNTIME_RECORD_UNREADABLE",
            Self::Admission => "ADMISSION_UNAVAILABLE",
            Self::Stop => "STOP_FAILED",
            Self::Inspect => "INSPECT_FAILED",
            Self::Retire => "RETIRE_FAILED",
        }
    }
}

/// An Office marker or global-stop step failed; the legacy loop retries it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OfficeStepFailed;

/// The watchdog's effects, borrowed from the installing broker.
pub trait WatchdogCore {
    /// The Office address answered GET /api/status with 200, 401 or 403.
    fn office_healthy(&self) -> bool;
    /// The `office-offline-since` marker exists, whether or not its contents
    /// decode (the legacy `exists()`); failed when existence is unknown.
    fn offline_present(&self) -> Result<bool, OfficeStepFailed>;
    /// The marker's timestamp (the legacy `float(read_text())`): `None` when
    /// absent, failed when present but unreadable or malformed.
    fn offline_since(&self) -> Result<Option<f64>, OfficeStepFailed>;
    fn mark_offline(&self, now: f64) -> Result<(), OfficeStepFailed>;
    /// Remove the marker; an absent marker is success.
    fn clear_offline(&self) -> Result<(), OfficeStepFailed>;
    fn stop_laptops(&self) -> Result<(), OfficeStepFailed>;
    /// Registered laptops not attached to a live viewer: (session, container).
    fn detached(&self) -> Vec<(String, String)>;
    /// Every registered laptop session, attached to a viewer or not.
    fn registered(&self) -> Vec<String>;
    /// The runtime record names an exit marker that exists.
    fn completed(&self, session: &str) -> Result<bool, SweepStep>;
    fn allowed(&self, session: &str) -> Result<bool, SweepStep>;
    fn stop(&self, container: &str) -> Result<(), SweepStep>;
    fn running(&self, container: &str) -> Result<bool, SweepStep>;
    fn retire(&self, session: &str) -> Result<(), SweepStep>;
    fn log(&self, line: &str);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Failure {
    count: u16,
    first: u64,
    last: u64,
}
/// Fixed bounds: `session_limit` sessions and `CODES_PER_SESSION` codes each.
/// Past either bound the newest entry is dropped and earlier ones are kept.
pub struct Watchdog {
    session_limit: usize,
    tick: u64,
    failures: BTreeMap<String, BTreeMap<SweepStep, Failure>>,
}
impl Watchdog {
    pub fn new(session_limit: usize) -> Self {
        Self {
            session_limit,
            tick: 0,
            failures: BTreeMap::new(),
        }
    }
    /// One legacy loop body at wall-clock `now` (seconds since the epoch).
    pub fn tick(&mut self, core: &dyn WatchdogCore, now: f64) {
        self.tick = self.tick.saturating_add(1);
        office(core, now);
        for (session, container) in core.detached() {
            match sweep(core, &session, &container) {
                Ok(()) => self.recovered(core, &session),
                Err(step) => self.record(core, &session, step),
            }
        }
        // Only unregistering clears a record without a successful sweep; an
        // attached viewer does not.
        let registered = core.registered();
        self.failures
            .retain(|session, _| registered.contains(session));
    }
    /// Run until `closed`, a tick every 2 s, as `stopping.wait(2)` does.
    pub fn run(&mut self, core: &dyn WatchdogCore, closed: &AtomicBool, now: impl Fn() -> f64) {
        while wait_tick(closed) {
            self.tick(core, now());
        }
    }
    /// The optional status field: `None` when nothing failed, so the legacy
    /// status bytes are unchanged.
    pub fn status_field(&self) -> Option<BrokerReply> {
        if self.failures.is_empty() {
            return None;
        }
        Some(BrokerReply::array(
            self.failures
                .iter()
                .map(|(session, codes)| session_reply(session, codes))
                .collect(),
        ))
    }
    fn record(&mut self, core: &dyn WatchdogCore, session: &str, step: SweepStep) {
        let full = self.failures.len() >= self.session_limit;
        let Some(codes) = (match self.failures.get_mut(session) {
            Some(codes) => Some(codes),
            None if full => None,
            None => Some(self.failures.entry(session.into()).or_default()),
        }) else {
            return;
        };
        if let Some(failure) = codes.get_mut(&step) {
            failure.count = failure.count.saturating_add(1);
            failure.last = self.tick;
        } else if codes.len() < CODES_PER_SESSION {
            codes.insert(
                step,
                Failure {
                    count: 1,
                    first: self.tick,
                    last: self.tick,
                },
            );
            core.log(&format!(
                "Laptop sweep for {session} failed: {}; retrying each tick.",
                step.code()
            ));
        }
    }
    fn recovered(&mut self, core: &dyn WatchdogCore, session: &str) {
        if self.failures.remove(session).is_some() {
            core.log(&format!("Laptop sweep for {session} recovered."));
        }
    }
}
/// Wait one tick; false as soon as `closed` is set.
fn wait_tick(closed: &AtomicBool) -> bool {
    let wake = Instant::now() + TICK;
    while Instant::now() < wake {
        if closed.load(Ordering::Acquire) {
            return false;
        }
        std::thread::sleep(POLL);
    }
    !closed.load(Ordering::Acquire)
}
fn session_reply(session: &str, codes: &BTreeMap<SweepStep, Failure>) -> BrokerReply {
    let codes = codes
        .iter()
        .map(|(step, failure)| {
            BrokerReply::object(vec![
                ("code", BrokerReply::string(step.code())),
                ("count", BrokerReply::integer(failure.count.into())),
                ("firstTick", BrokerReply::integer(clamp(failure.first))),
                ("lastTick", BrokerReply::integer(clamp(failure.last))),
            ])
        })
        .collect();
    BrokerReply::object(vec![
        ("sessionId", BrokerReply::string(session)),
        ("codes", BrokerReply::array(codes)),
    ])
}
fn clamp(tick: u64) -> i64 {
    i64::try_from(tick).unwrap_or(i64::MAX)
}
/// The legacy Office half, unchanged: any failure waits for the next tick.
fn office(core: &dyn WatchdogCore, now: f64) {
    let healthy = core.office_healthy();
    let Ok(present) = core.offline_present() else {
        return;
    };
    if healthy {
        if present {
            core.log("Office API recovered; laptop outage timer cleared.");
        }
        let _ = core.clear_offline();
        return;
    }
    if !present {
        if core.mark_offline(now).is_err() {
            return;
        }
        core.log("Office API unavailable; laptops will stop after 10 minutes without recovery.");
    }
    // The marker is read back, as legacy did; a malformed one waits a tick.
    let Ok(Some(since)) = core.offline_since() else {
        return;
    };
    if now - since >= OFFLINE_GRACE_SECONDS {
        let _ = core.stop_laptops();
    }
}
/// The legacy per-laptop sweep: stop a completed or no-longer-allowed laptop,
/// then retire it once it is not running. The first failing step is returned.
fn sweep(core: &dyn WatchdogCore, session: &str, container: &str) -> Result<(), SweepStep> {
    let completed = core.completed(session)?;
    if completed || !core.allowed(session)? {
        core.stop(container)?;
    }
    if !core.running(container)? {
        core.retire(session)?;
    }
    Ok(())
}
