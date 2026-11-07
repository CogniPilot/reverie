//! Cancel a REAL admitted HTTP waiter while its actual fixed child is held,
//! then observe the original completed native job without publishing a cache.
use super::*;
use crate::office::native_jobs::NativeValue;
fn orphaned_completed_lookup() -> (Fixture, Instant) {
    let fixture = fixture();
    let phone = fixture.bind("phone");
    fs::write(fixture.root.join("hold.next"), b"actual query hold").unwrap();
    let mut stream = UnixStream::connect(fixture.root.join("phone/office.sock")).unwrap();
    stream
        .write_all(b"GET /api/instances HTTP/1.1\r\nHost: guest\r\nContent-Length: 0\r\n\r\n")
        .unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while !fixture.root.join("query-started").exists() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(2));
    }
    let entered = fixture.root.join("query-started").exists();
    let closed = fixture
        .service
        .close_phone(&phone, Instant::now() + Duration::from_millis(50));
    drop(stream);
    // Always release the actual child before setup assertions/finalizers.
    fs::write(fixture.root.join("query-release"), b"same native child").unwrap();
    let job = fixture
        .service
        .company
        .address
        .observed_lookup()
        .expect("actual lookup selected before HTTP cancellation");
    let until = Instant::now() + Duration::from_secs(5);
    let completed = loop {
        if let Some(result) = job.poll().unwrap() {
            break result;
        }
        assert!(
            Instant::now() < until,
            "same native job completed after release"
        );
        std::thread::sleep(Duration::from_millis(2));
    };
    fixture
        .service
        .close_phone(&phone, Instant::now() + Duration::from_secs(2))
        .unwrap();
    assert!(entered, "actual fixed engine child entered");
    assert!(
        closed.is_err(),
        "cancelled waiter retained its actual job/seat"
    );
    let NativeValue::Address(_, at) = completed.unwrap() else {
        panic!("actual backend result")
    };
    assert!(
        fixture.service.company.address.observed_lookup().is_some(),
        "cancelled future did not publish/clear cache.inflight"
    );
    assert_eq!(queries(&fixture), vec!["inspect\0test-console"]);
    (fixture, at)
}
fn replace_reply(fixture: &Fixture) {
    fs::write(fixture.root.join("inspect.out"),br#"[{"State":{"Running":true},"NetworkSettings":{"Networks":{"bridge":{"IPAddress":"127.0.0.2"}}}}]"#).unwrap();
}
fn next_addresses(fixture: &Fixture) -> Vec<SocketAddr> {
    let runtime = server::runtime().unwrap();
    runtime
        .block_on(fixture.service.company.address.targets(
            &fixture.service.company,
            lifetime(Arc::new(AtomicUsize::new(0))),
        ))
        .unwrap()
}
#[test]
fn cancelled_http_completion_expires_before_later_waiter_and_requires_fresh_query() {
    let (fixture, at) = orphaned_completed_lookup();
    replace_reply(&fixture);
    let expires = at + Duration::from_secs(2);
    while Instant::now() < expires {
        std::thread::sleep(
            expires
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(10)),
        );
    }
    assert!(at.elapsed() >= Duration::from_secs(2));
    let addresses = next_addresses(&fixture);
    assert_eq!(
        addresses,
        vec!["127.0.0.2:3000".parse::<SocketAddr>().unwrap()]
    );
    assert_eq!(
        queries(&fixture),
        vec!["inspect\0test-console", "inspect\0test-console"]
    );
}
#[test]
fn cancelled_http_completion_still_fresh_is_used_without_reissuing_query() {
    let (fixture, at) = orphaned_completed_lookup();
    replace_reply(&fixture);
    // This positive control starts while the ACTUAL completion is fresh; no
    // timestamp rewrite or production clock selector can reset its age.
    assert!(
        at.elapsed() < Duration::from_secs(2),
        "fresh-result setup stayed inside original TTL"
    );
    assert_eq!(
        next_addresses(&fixture),
        vec!["127.0.0.1:3000".parse::<SocketAddr>().unwrap()]
    );
    assert_eq!(queries(&fixture), vec!["inspect\0test-console"]);
}
