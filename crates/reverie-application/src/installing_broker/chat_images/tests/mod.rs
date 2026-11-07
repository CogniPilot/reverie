use super::*;
use serde_json::{Value as Json, json};
use std::{
    fs,
    io::{Read, Write},
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        net::UnixStream,
    },
    path::{Path, PathBuf},
    process::Command,
};
mod backend;
mod fixture;
mod namespace;
mod protocol;
const SID: &str = "11111111-1111-4111-8111-111111111111";
const EID: &str = "22222222-2222-4222-8222-222222222222";
const RID: &str = "33333333-3333-4333-8333-333333333333";
const MID: &str = "44444444-4444-4444-8444-444444444444";
const FID: &str = "55555555-5555-4555-8555-555555555555";
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nowned M bytes\0\xff";
fn end() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
fn scope(generation: &str) -> Json {
    json!({"version":1,"sessionId":SID,"roomId":RID,"messageId":MID,"generation":generation,"fileIds":[FID]})
}
fn binding() -> Json {
    json!({"purpose":"chat-image-paths-v1","action":"binding","sessionId":SID})
}
fn materialize(generation: &str) -> Json {
    json!({"purpose":"chat-image-paths-v1","action":"materialize","sessionId":SID,"request":scope(generation)})
}
#[test]
fn actual_m_record_namespace_office_cache_and_fresh_repeated_authorization() {
    if namespace::isolate("actual_m_record_namespace_office_cache_and_fresh_repeated_authorization")
    {
        return;
    }
    let mut fixture = fixture::Fixture::new();
    fixture.mount();
    fixture.recover();
    let (kind, bound, closed) = protocol::call(&fixture.broker, &binding());
    assert_eq!(kind, b'J');
    assert!(closed.unwrap().primary_error().is_none());
    let generation = bound["generation"].as_str().unwrap();
    let server = backend::serve(6, backend::ReplyMode::Allowed, None);
    let first = protocol::call(&fixture.broker, &materialize(generation));
    let second = protocol::call(&fixture.broker, &materialize(generation));
    let requests = server.join().unwrap();
    for result in [&first, &second] {
        assert_eq!(result.0, b'J');
        assert!(result.2.as_ref().unwrap().primary_error().is_none());
        assert_eq!(result.1["status"], "ready");
        assert_eq!(result.1["generation"], generation);
        let name = Path::new(result.1["files"][0]["path"].as_str().unwrap())
            .file_name()
            .unwrap();
        assert_eq!(
            fs::read(
                fixture
                    .temporary
                    .join(reverie_core::chat_images::CACHE_NAME)
                    .join(name)
            )
            .unwrap(),
            PNG
        );
    }
    assert_ne!(
        first.1["files"][0]["path"], second.1["files"][0]["path"],
        "no stale cache hit may bypass fetch"
    );
    assert_eq!(requests.len(), 6);
    assert_eq!(fixture.broker.images.admitted.load(Ordering::Acquire), 0);
    fixture.close();
}
#[test]
fn actual_m_refuses_declared_tmp_without_real_namespace_binding_before_cache_creation() {
    if namespace::isolate(
        "actual_m_refuses_declared_tmp_without_real_namespace_binding_before_cache_creation",
    ) {
        return;
    }
    let mut fixture = fixture::Fixture::new();
    fixture.recover();
    let (kind, response, closed) = protocol::call(&fixture.broker, &binding());
    assert_eq!(kind, b'E');
    assert_eq!(response["error"], "scratch_unverified");
    assert_eq!(
        closed.unwrap().primary_error().unwrap().code(),
        "scratch_unverified"
    );
    assert!(
        !fixture
            .temporary
            .join(reverie_core::chat_images::CACHE_NAME)
            .exists()
    );
    fixture.close();
}
#[test]
fn actual_m_revoked_message_and_changed_current_employee_never_publish_ready() {
    if namespace::isolate(
        "actual_m_revoked_message_and_changed_current_employee_never_publish_ready",
    ) {
        return;
    }
    let mut fixture = fixture::Fixture::new();
    fixture.mount();
    fixture.recover();
    let bound = protocol::call(&fixture.broker, &binding()).1;
    let generation = bound["generation"].as_str().unwrap();
    let server = backend::serve(3, backend::ReplyMode::Revoked, None);
    let (kind, response, closed) = protocol::call(&fixture.broker, &materialize(generation));
    assert_eq!(server.join().unwrap().len(), 3);
    assert_eq!(kind, b'E');
    assert_eq!(response["error"], "message_or_file_refused");
    assert!(closed.unwrap().primary_error().is_some());
    assert_eq!(
        fs::read_dir(
            fixture
                .temporary
                .join(reverie_core::chat_images::CACHE_NAME)
        )
        .unwrap()
        .count(),
        0
    );
    let server = backend::serve(
        3,
        backend::ReplyMode::Allowed,
        Some(fixture.root.join("company.json")),
    );
    let (kind, response, closed) = protocol::call(&fixture.broker, &materialize(generation));
    assert_eq!(server.join().unwrap().len(), 3);
    assert_eq!(kind, b'E');
    assert_eq!(response["error"], "binding_changed");
    assert!(closed.unwrap().primary_error().is_some());
    assert_eq!(
        fs::read_dir(
            fixture
                .temporary
                .join(reverie_core::chat_images::CACHE_NAME)
        )
        .unwrap()
        .count(),
        0
    );
    fixture.close();
}
#[test]
fn actual_busy_precedes_decode_and_closed_peer_failure_does_not_retain_known_cleanup() {
    if namespace::isolate(
        "actual_busy_precedes_decode_and_closed_peer_failure_does_not_retain_known_cleanup",
    ) {
        return;
    }
    let mut fixture = fixture::Fixture::new();
    let mut one = fixture.broker.images.admit().unwrap();
    let mut two = fixture.broker.images.admit().unwrap();
    let (kind, response, closed) =
        protocol::call(&fixture.broker, &json!({"not":"a valid M request"}));
    assert_eq!(kind, b'E');
    assert_eq!(response["error"], "busy");
    assert_eq!(closed.unwrap().primary_error().unwrap().code(), "busy");
    one.release();
    two.release();
    let (client, connection) = protocol::connection(&fixture.broker, &json!({}));
    drop(client);
    let closed = fixture.broker.handle_chat_images(connection).unwrap();
    assert_eq!(closed.primary_error().unwrap().code(), "invalid_request");
    assert_eq!(fixture.broker.images.admitted.load(Ordering::Acquire), 0);
    assert!(
        !fixture.root.join("calls.txt").exists(),
        "no metadata for malformed/Busy input"
    );
    fixture.close();
}
