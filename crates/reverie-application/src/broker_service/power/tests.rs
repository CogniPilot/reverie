use super::*;
use std::sync::atomic::AtomicUsize;

#[derive(Default)]
struct Fake {
    ops: bool,
    maintainers: Vec<String>,
    stop_fails: bool,
    stops: AtomicUsize,
    website: Mutex<Vec<WebsiteAction>>,
    sweep: Option<&'static str>,
    /// The next engine call panics.
    panic_once: AtomicBool,
    /// Each laptop stop takes this long on the test clock.
    slow_stop: Option<(Arc<TestClock>, Duration)>,
}
struct TestClock {
    base: Instant,
    elapsed: Mutex<Duration>,
}
impl TestClock {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            base: Instant::now(),
            elapsed: Mutex::new(Duration::ZERO),
        })
    }
    fn advance(&self, by: Duration) {
        *self.elapsed.lock().unwrap() += by;
    }
    fn clock(self: &Arc<Self>) -> Clock {
        let clock = self.clone();
        Arc::new(move || clock.base + *clock.elapsed.lock().unwrap())
    }
}
impl PowerCore for Fake {
    fn ops_configured(&self) -> bool {
        self.ops
    }
    fn maintenance_session(&self, caller: &str) -> bool {
        self.maintainers.iter().any(|m| m == caller)
    }
    fn reload_resources(&self) -> Result<BrokerReply, Refusal> {
        Ok(BrokerReply::object(vec![
            ("action", BrokerReply::string("reload-resources")),
            ("success", BrokerReply::boolean(true)),
        ]))
    }
    fn inventory(&self) -> (i64, Vec<String>) {
        (2, vec!["a".into()])
    }
    fn provider_health(&self) -> BrokerReply {
        BrokerReply::object(vec![("providerHealth", BrokerReply::null())])
    }
    fn stop_laptops(&self) -> Result<(), Refusal> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        if let Some((clock, takes)) = &self.slow_stop {
            clock.advance(*takes);
        }
        if self.stop_fails {
            return Err(Refusal::Message(
                "Some laptops could not be stopped; the website is being kept online".into(),
            ));
        }
        Ok(())
    }
    fn website(&self, action: WebsiteAction) {
        assert!(
            !self.panic_once.swap(false, Ordering::SeqCst),
            "engine call panicked"
        );
        self.website.lock().unwrap().push(action);
    }
    fn sweep_failures(&self) -> Option<BrokerReply> {
        self.sweep.map(BrokerReply::string)
    }
}
fn text(value: &str) -> ControlField {
    ControlField::Text(value.into())
}
fn reply(result: Result<BrokerReply, Refusal>) -> String {
    String::from_utf8(result.unwrap().encode()).unwrap()
}
fn power(core: Fake) -> (Arc<Fake>, Power) {
    clocked(core, &TestClock::new())
}
fn clocked(core: Fake, clock: &Arc<TestClock>) -> (Arc<Fake>, Power) {
    let core = Arc::new(core);
    let power = Power::with_clock(core.clone(), Duration::from_millis(10), clock.clock());
    (core, power)
}
fn spacing() -> Option<Refusal> {
    Some(Refusal::Message(
        "Wait one minute between website restarts".into(),
    ))
}
fn wait_idle(p: &Power) {
    let start = Instant::now();
    while p.busy.load(Ordering::Acquire) {
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "maintenance stayed busy"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn wait_for_website(core: &Fake, count: usize) {
    let start = Instant::now();
    while core.website.lock().unwrap().len() < count {
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "website task never ran"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn status_matches_the_legacy_bytes_and_adds_only_present_failures() {
    let (_, p) = power(Fake::default());
    assert_eq!(
        reply(p.control(&text("status"), None)),
        r#"{"runningLaptops": 2, "runningSessionIds": ["a"], "offlineGraceSeconds": 600}"#
    );
    let (_, p) = power(Fake {
        sweep: Some("x"),
        ..Fake::default()
    });
    assert_eq!(
        reply(p.control(&text("status"), None)),
        r#"{"runningLaptops": 2, "runningSessionIds": ["a"], "offlineGraceSeconds": 600, "sweepFailures": "x"}"#
    );
}

// P7: website power stops laptops, then schedules only the website action.
#[test]
fn shutdown_stops_laptops_then_schedules_the_website_stop() {
    let (core, p) = power(Fake::default());
    assert_eq!(
        reply(p.control(&text("shutdown"), None)),
        r#"{"action": "shutdown", "success": true}"#
    );
    assert_eq!(core.stops.load(Ordering::SeqCst), 1);
    wait_for_website(&core, 1);
    assert_eq!(*core.website.lock().unwrap(), [WebsiteAction::Stop]);
}

// P7 (b): a failed laptop stop keeps the website online.
#[test]
fn failed_laptop_stop_schedules_no_website_action() {
    let (core, p) = power(Fake {
        stop_fails: true,
        ..Fake::default()
    });
    assert_eq!(
        p.control(&text("shutdown"), None).err(),
        Some(Refusal::Message(
            "Some laptops could not be stopped; the website is being kept online".into()
        ))
    );
    std::thread::sleep(Duration::from_millis(50));
    assert!(core.website.lock().unwrap().is_empty());
}

#[test]
fn stop_laptops_has_no_website_action() {
    let (core, p) = power(Fake::default());
    assert_eq!(
        reply(p.control(&text("stop-laptops"), None)),
        r#"{"action": "stop-laptops", "success": true}"#
    );
    std::thread::sleep(Duration::from_millis(50));
    assert!(core.website.lock().unwrap().is_empty());
}

#[test]
fn restart_does_not_stop_laptops_and_is_spaced_one_minute() {
    let clock = TestClock::new();
    let (core, p) = clocked(Fake::default(), &clock);
    reply(p.control(&text("restart-website"), None));
    assert_eq!(core.stops.load(Ordering::SeqCst), 0);
    wait_for_website(&core, 1);
    wait_idle(&p);
    clock.advance(Duration::from_secs(59));
    assert_eq!(p.control(&text("restart-website"), None).err(), spacing());
    clock.advance(Duration::from_secs(1));
    reply(p.control(&text("restart-website"), None));
    wait_for_website(&core, 2);
}

// The stamp is taken after a slow laptop stop, as legacy sampled its clock
// after stop_laptops(), so the next restart is spaced from the stop's end.
#[test]
fn a_slow_shutdown_stop_spaces_the_next_restart_from_its_end() {
    let clock = TestClock::new();
    let (core, p) = clocked(
        Fake {
            slow_stop: Some((clock.clone(), Duration::from_secs(30))),
            ..Fake::default()
        },
        &clock,
    );
    reply(p.control(&text("shutdown"), None));
    wait_for_website(&core, 1);
    wait_idle(&p);
    clock.advance(Duration::from_secs(59));
    assert_eq!(p.control(&text("restart-website"), None).err(), spacing());
    clock.advance(Duration::from_secs(1));
    reply(p.control(&text("restart-website"), None));
    wait_for_website(&core, 2);
}

// Improvement D2: with no maintenance yet the first restart is never spaced,
// even at the clock's first instant (legacy's 0.0 stamp spaced it there).
#[test]
fn the_first_restart_is_never_spaced() {
    let clock = TestClock::new();
    let (core, p) = clocked(Fake::default(), &clock);
    reply(p.control(&text("restart-website"), None));
    wait_for_website(&core, 1);
}

#[test]
fn maintenance_runs_one_at_a_time() {
    let core = Arc::new(Fake::default());
    let p = Power::with_clock(
        core.clone(),
        Duration::from_millis(200),
        TestClock::new().clock(),
    );
    reply(p.control(&text("shutdown"), None));
    assert_eq!(
        p.control(&text("shutdown"), None).err(),
        Some(Refusal::Message(
            "Website maintenance is already running".into()
        ))
    );
    wait_for_website(&core, 1);
    wait_idle(&p);
    reply(p.control(&text("shutdown"), None));
}

#[test]
fn ops_configuration_refuses_the_legacy_restart() {
    let (_, p) = power(Fake {
        ops: true,
        ..Fake::default()
    });
    assert_eq!(
        p.control(&text("restart-website"), None).err(),
        Some(Refusal::Message(
            "Use the structured OPS restart with current authority, artifact and generation fences"
                .into()
        ))
    );
}

#[test]
fn a_caller_may_only_restart_and_only_when_granted() {
    let (core, p) = power(Fake {
        maintainers: vec!["s1".into()],
        ..Fake::default()
    });
    let denied = Some(Refusal::Message(
        "This laptop has no owner-granted website maintenance permission".into(),
    ));
    assert_eq!(
        p.control(&text("shutdown"), Some(&text("s1"))).err(),
        denied
    );
    assert_eq!(
        p.control(&text("restart-website"), Some(&text("s2"))).err(),
        denied
    );
    assert_eq!(
        p.control(
            &text("restart-website"),
            Some(&ControlField::Integer("1".into())),
        )
        .err(),
        denied
    );
    reply(p.control(&text("restart-website"), Some(&text("s1"))));
    wait_for_website(&core, 1);
}

#[test]
fn unknown_and_other_routes() {
    let (_, p) = power(Fake::default());
    for action in [
        text("bogus"),
        ControlField::Integer("5".into()),
        ControlField::Other,
    ] {
        assert_eq!(
            p.control(&action, None).err(),
            Some(Refusal::Message("Unknown office power action".into())),
            "{action:?}"
        );
    }
    assert_eq!(
        reply(p.control(&text("reload-resources"), None)),
        r#"{"action": "reload-resources", "success": true}"#
    );
    assert_eq!(
        reply(p.control(&text("provider-health"), None)),
        r#"{"providerHealth": null}"#
    );
}

// A panicking engine call still releases maintenance, as the legacy finally did.
#[test]
fn a_panicking_website_task_releases_maintenance() {
    let (core, p) = power(Fake {
        panic_once: AtomicBool::new(true),
        ..Fake::default()
    });
    reply(p.control(&text("shutdown"), None));
    wait_idle(&p);
    assert!(core.website.lock().unwrap().is_empty());
    reply(p.control(&text("shutdown"), None));
    wait_for_website(&core, 1);
}
