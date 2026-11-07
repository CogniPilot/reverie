use super::*;
use std::cell::RefCell;

#[derive(Default)]
struct Fake {
    healthy: bool,
    marker: RefCell<Option<f64>>,
    /// A present marker whose contents do not decode.
    malformed: RefCell<bool>,
    /// Registered sessions attached to a live viewer, so not swept.
    attached: RefCell<Vec<String>>,
    laptops: RefCell<Vec<(String, String)>>,
    completed: Vec<String>,
    refused: Vec<String>,
    stopped_containers: RefCell<Vec<String>>,
    not_running: Vec<String>,
    /// A failing step per session, consumed one per tick when scripted.
    fail: RefCell<BTreeMap<String, Vec<SweepStep>>>,
    sticky: BTreeMap<String, SweepStep>,
    stop_laptops: RefCell<usize>,
    calls: RefCell<Vec<String>>,
    logs: RefCell<Vec<String>>,
}
impl Fake {
    fn laptop(self, session: &str) -> Self {
        self.laptops
            .borrow_mut()
            .push((session.into(), format!("laptop-{session}")));
        self
    }
    fn failing(&self, session: &str, step: SweepStep) -> Result<(), SweepStep> {
        if self.sticky.get(session) == Some(&step) {
            return Err(step);
        }
        let mut fail = self.fail.borrow_mut();
        if let Some(steps) = fail.get_mut(session)
            && steps.first() == Some(&step)
        {
            steps.remove(0);
            return Err(step);
        }
        Ok(())
    }
    fn session_of(container: &str) -> &str {
        container.trim_start_matches("laptop-")
    }
}
impl WatchdogCore for Fake {
    fn office_healthy(&self) -> bool {
        self.healthy
    }
    fn offline_present(&self) -> Result<bool, OfficeStepFailed> {
        Ok(self.marker.borrow().is_some() || *self.malformed.borrow())
    }
    fn offline_since(&self) -> Result<Option<f64>, OfficeStepFailed> {
        if *self.malformed.borrow() {
            return Err(OfficeStepFailed);
        }
        Ok(*self.marker.borrow())
    }
    fn mark_offline(&self, now: f64) -> Result<(), OfficeStepFailed> {
        *self.marker.borrow_mut() = Some(now);
        Ok(())
    }
    fn clear_offline(&self) -> Result<(), OfficeStepFailed> {
        *self.marker.borrow_mut() = None;
        *self.malformed.borrow_mut() = false;
        Ok(())
    }
    fn stop_laptops(&self) -> Result<(), OfficeStepFailed> {
        *self.stop_laptops.borrow_mut() += 1;
        Ok(())
    }
    fn detached(&self) -> Vec<(String, String)> {
        let attached = self.attached.borrow();
        self.laptops
            .borrow()
            .iter()
            .filter(|(s, _)| !attached.contains(s))
            .cloned()
            .collect()
    }
    fn registered(&self) -> Vec<String> {
        self.laptops
            .borrow()
            .iter()
            .map(|(s, _)| s.clone())
            .collect()
    }
    fn completed(&self, session: &str) -> Result<bool, SweepStep> {
        self.calls.borrow_mut().push(format!("completed {session}"));
        self.failing(session, SweepStep::RuntimeRecord)?;
        Ok(self.completed.iter().any(|s| s == session))
    }
    fn allowed(&self, session: &str) -> Result<bool, SweepStep> {
        self.failing(session, SweepStep::Admission)?;
        Ok(!self.refused.iter().any(|s| s == session))
    }
    fn stop(&self, container: &str) -> Result<(), SweepStep> {
        self.failing(Self::session_of(container), SweepStep::Stop)?;
        self.stopped_containers.borrow_mut().push(container.into());
        Ok(())
    }
    fn running(&self, container: &str) -> Result<bool, SweepStep> {
        self.failing(Self::session_of(container), SweepStep::Inspect)?;
        Ok(!self
            .not_running
            .iter()
            .any(|s| container.ends_with(s.as_str())))
    }
    fn retire(&self, session: &str) -> Result<(), SweepStep> {
        self.failing(session, SweepStep::Retire)?;
        self.laptops.borrow_mut().retain(|(s, _)| s != session);
        Ok(())
    }
    fn log(&self, line: &str) {
        self.logs.borrow_mut().push(line.into());
    }
}
fn text(reply: Option<BrokerReply>) -> Option<String> {
    reply.map(|r| String::from_utf8(r.encode()).unwrap())
}

#[test]
fn office_outage_stops_laptops_only_after_the_grace() {
    let core = Fake::default();
    let mut dog = Watchdog::new(4);
    dog.tick(&core, 1000.0);
    assert_eq!(*core.marker.borrow(), Some(1000.0));
    assert_eq!(core.logs.borrow().len(), 1);
    dog.tick(&core, 1599.0);
    assert_eq!(*core.stop_laptops.borrow(), 0);
    dog.tick(&core, 1600.0);
    assert_eq!(*core.stop_laptops.borrow(), 1);
    assert_eq!(core.logs.borrow().len(), 1, "the outage is logged once");
}

#[test]
fn office_recovery_clears_the_marker_and_logs_once() {
    let core = Fake {
        healthy: true,
        ..Fake::default()
    };
    *core.marker.borrow_mut() = Some(5.0);
    let mut dog = Watchdog::new(4);
    dog.tick(&core, 10.0);
    dog.tick(&core, 12.0);
    assert_eq!(*core.marker.borrow(), None);
    assert_eq!(
        core.logs.borrow().as_slice(),
        ["Office API recovered; laptop outage timer cleared."]
    );
}

#[test]
fn completed_or_refused_laptops_are_stopped_then_retired() {
    let core = Fake {
        healthy: true,
        completed: vec!["a".into()],
        refused: vec!["b".into()],
        not_running: vec!["a".into(), "b".into()],
        ..Fake::default()
    }
    .laptop("a")
    .laptop("b")
    .laptop("c");
    let mut dog = Watchdog::new(4);
    dog.tick(&core, 1.0);
    assert_eq!(
        core.stopped_containers.borrow().as_slice(),
        ["laptop-a", "laptop-b"]
    );
    let left: Vec<_> = core
        .laptops
        .borrow()
        .iter()
        .map(|(s, _)| s.clone())
        .collect();
    assert_eq!(left, ["c"]);
}

// P3 (a): nothing failed, so status carries no new field.
#[test]
fn no_failures_leaves_status_unchanged() {
    let core = Fake {
        healthy: true,
        ..Fake::default()
    }
    .laptop("a");
    let mut dog = Watchdog::new(4);
    dog.tick(&core, 1.0);
    assert!(dog.status_field().is_none());
}

// P3 (b): a persistent failure is logged once, retried every tick, counted.
#[test]
fn persistent_failure_is_recorded_once_and_retried_each_tick() {
    let mut core = Fake {
        healthy: true,
        ..Fake::default()
    }
    .laptop("a");
    core.sticky.insert("a".into(), SweepStep::RuntimeRecord);
    let mut dog = Watchdog::new(4);
    for now in [2.0, 4.0, 6.0] {
        dog.tick(&core, now);
    }
    assert_eq!(
        core.calls.borrow().len(),
        3,
        "the legacy retry each tick stays"
    );
    assert_eq!(
        core.logs.borrow().as_slice(),
        ["Laptop sweep for a failed: RUNTIME_RECORD_UNREADABLE; retrying each tick."]
    );
    assert_eq!(
        text(dog.status_field()).unwrap(),
        r#"[{"sessionId": "a", "codes": [{"code": "RUNTIME_RECORD_UNREADABLE", "count": 3, "firstTick": 1, "lastTick": 3}]}]"#
    );
}

#[test]
fn a_successful_sweep_clears_the_record_and_logs_recovery() {
    let core = Fake {
        healthy: true,
        ..Fake::default()
    }
    .laptop("a");
    core.fail
        .borrow_mut()
        .insert("a".into(), vec![SweepStep::Admission]);
    let mut dog = Watchdog::new(4);
    dog.tick(&core, 1.0);
    assert!(dog.status_field().is_some());
    dog.tick(&core, 3.0);
    assert!(dog.status_field().is_none());
    assert_eq!(
        core.logs.borrow().last().unwrap(),
        "Laptop sweep for a recovered."
    );
}

// P3 (c): past either bound the newest entry is dropped.
#[test]
fn bounds_drop_the_newest_and_keep_earlier_entries() {
    let mut core = Fake {
        healthy: true,
        ..Fake::default()
    }
    .laptop("a")
    .laptop("b")
    .laptop("c");
    for session in ["a", "b", "c"] {
        core.sticky.insert(session.into(), SweepStep::Admission);
    }
    let mut dog = Watchdog::new(2);
    dog.tick(&core, 1.0);
    let status = text(dog.status_field()).unwrap();
    assert!(status.contains(r#""a""#) && status.contains(r#""b""#));
    assert!(!status.contains(r#""c""#), "{status}");

    let core = Fake {
        healthy: true,
        ..Fake::default()
    }
    .laptop("d");
    core.fail.borrow_mut().insert(
        "d".into(),
        vec![
            SweepStep::RuntimeRecord,
            SweepStep::Admission,
            SweepStep::Stop,
            SweepStep::Inspect,
            SweepStep::Retire,
        ],
    );
    // Refused, so every step runs in order: each tick fails the next one.
    let core = Fake {
        refused: vec!["d".into()],
        not_running: vec!["d".into()],
        ..core
    };
    let mut dog = Watchdog::new(4);
    for now in 1..=5 {
        dog.tick(&core, f64::from(now));
    }
    let status = text(dog.status_field()).unwrap();
    for kept in [
        "RUNTIME_RECORD_UNREADABLE",
        "ADMISSION_UNAVAILABLE",
        "STOP_FAILED",
        "INSPECT_FAILED",
    ] {
        assert!(status.contains(kept), "{kept}: {status}");
    }
    assert!(
        !status.contains("RETIRE_FAILED"),
        "the fifth, newest code is dropped: {status}"
    );
}

#[test]
fn run_returns_promptly_once_closed() {
    let core = Fake::default();
    let closed = AtomicBool::new(true);
    let start = Instant::now();
    Watchdog::new(4).run(&core, &closed, || 0.0);
    assert!(start.elapsed() < Duration::from_millis(200));
    assert!(core.logs.borrow().is_empty(), "no tick after close");
}

// Attaching a viewer keeps a failure; only unregistering clears it.
#[test]
fn a_failure_survives_attach_and_clears_on_unregister() {
    let mut core = Fake {
        healthy: true,
        ..Fake::default()
    }
    .laptop("a");
    core.sticky.insert("a".into(), SweepStep::Admission);
    let mut dog = Watchdog::new(4);
    dog.tick(&core, 1.0);
    core.attached.borrow_mut().push("a".into());
    dog.tick(&core, 3.0);
    let status = text(dog.status_field()).unwrap();
    assert!(status.contains("ADMISSION_UNAVAILABLE"), "{status}");
    assert_eq!(
        core.calls.borrow().len(),
        1,
        "an attached laptop is not swept"
    );
    core.laptops.borrow_mut().clear();
    dog.tick(&core, 5.0);
    assert!(dog.status_field().is_none(), "unregistering clears it");
}

// Recovery logs on marker presence, as the legacy exists() did, even
// when the marker's contents are malformed.
#[test]
fn recovery_logs_for_a_malformed_present_marker() {
    let core = Fake {
        healthy: true,
        ..Fake::default()
    };
    *core.malformed.borrow_mut() = true;
    let mut dog = Watchdog::new(4);
    dog.tick(&core, 1.0);
    assert_eq!(
        core.logs.borrow().as_slice(),
        ["Office API recovered; laptop outage timer cleared."]
    );
    assert_eq!(core.offline_present(), Ok(false));
}

// The unhealthy half: a malformed present marker is not rewritten or logged,
// and its unreadable timestamp stops nothing (legacy ValueError, next tick).
#[test]
fn a_malformed_marker_while_offline_waits_without_stopping() {
    let core = Fake::default();
    *core.malformed.borrow_mut() = true;
    let mut dog = Watchdog::new(4);
    dog.tick(&core, 10_000.0);
    assert_eq!(*core.stop_laptops.borrow(), 0);
    assert!(core.logs.borrow().is_empty());
    assert!(*core.malformed.borrow(), "the marker is not rewritten");
}
