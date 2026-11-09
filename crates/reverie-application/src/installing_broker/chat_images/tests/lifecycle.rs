use super::*;
#[test]
fn actual_admitted_query_prevents_close_then_closed_manager_refuses_real_m_binding() {
    if namespace::isolate(
        "lifecycle::actual_admitted_query_prevents_close_then_closed_manager_refuses_real_m_binding",
    ) {
        return;
    }
    let mut fixture = fixture::Fixture::new();
    fixture.mount();
    fixture.recover();
    fs::write(
        fixture.root.join("inspect.hold"),
        b"owned native query hold",
    )
    .unwrap();
    let (mut client, connection) = protocol::connection(&fixture.broker, &binding());
    let (attempt, handled) = std::thread::scope(|scope| {
        let handler = scope.spawn(|| fixture.broker.handle_chat_images(connection));
        let wait = Instant::now() + Duration::from_secs(5);
        while !fixture.root.join("inspect.started").is_file() && Instant::now() < wait {
            std::thread::sleep(Duration::from_millis(2));
        }
        let entered = fixture.root.join("inspect.started").is_file();
        let attempt = if entered {
            fixture.broker.close_chat_images(end())
        } else {
            Err(ChatImagesError::Refused("fixture_query_not_started"))
        };
        // Always release/join the actual owned child before any assertion.
        fs::write(fixture.root.join("inspect.release"), b"owned release").unwrap();
        let handled = handler.join().unwrap();
        assert!(entered, "actual captured native query was admitted");
        (attempt, handled)
    });
    assert_eq!(attempt.err().unwrap().code(), "busy");
    assert!(handled.unwrap().primary_error().is_none());
    assert_eq!(protocol::reply(&mut client).0, b'J');
    fixture.broker.close_chat_images(end()).unwrap();
    let calls = fs::read(fixture.root.join("calls.txt")).unwrap();
    let (kind, response, result) = protocol::call(&fixture.broker, &binding());
    let afterward = fs::read(fixture.root.join("calls.txt")).unwrap();
    fixture.close();
    assert_eq!(
        kind, b'E',
        "known closed manager must fence real accepted M"
    );
    assert_eq!(response["error"], "cache_unavailable");
    assert_eq!(
        result.unwrap().primary_error().unwrap().code(),
        "cache_unavailable"
    );
    assert_eq!(
        calls, afterward,
        "post-close refusal precedes native dispatch"
    );
}
