//! The checks of python's tests/test_routines.py that are not a whole tick: fixed texts, the console client's refusals,
//! policy rules, and python's float and JSON behaviour.

use reverie_routines::console::Console;
use reverie_routines::json::{self, Json, py_float};
use reverie_routines::policy::load_zone;
use reverie_routines::tick::template;
use std::io::{Read, Write};
use std::net::TcpListener;

#[test]
fn templates_are_single_printable_lines_without_bang() {
    for kind in ["wind_down", "wake", "retro", "retro_compile", "kickoff"] {
        let text = template(kind, 120);
        assert!(
            text.len() <= 300 && text.bytes().all(|b| (b' '..=b'~').contains(&b)),
            "{text}"
        );
        assert!(!text.contains('!'), "{text}");
        assert!(
            text.starts_with("[automated - not the owner - routine "),
            "{text}"
        );
    }
    assert!(template("wind_down", 20).contains("starts in 20 min."));
    let compile = template("retro_compile", 0);
    assert!(
        compile.contains("your own")
            && compile.contains("attributed to its lead")
            && compile.contains("unverified")
    );
}

#[test]
fn the_console_must_be_loopback_http() {
    for url in [
        "http://127.0.0.1:3001",
        "http://localhost",
        "http://localhost:99999",
    ] {
        assert!(Console::new(url, None).is_some(), "{url}");
    }
    for url in [
        "https://127.0.0.1:3001",
        "http://10.0.0.1:3001",
        "http://127.0.0.1:3001/",
        "http://localhost:",
        "http://127.0.0.1:123456",
        "http://localhost.evil",
    ] {
        assert!(Console::new(url, None).is_none(), "{url}");
    }
}

#[test]
fn session_ids_are_checked_before_any_request() {
    let console = Console::new("http://127.0.0.1:9", Some("t".into())).expect("console");
    assert!(console.session("../x").is_err());
    assert!(console.send("../x", "t").is_err());
}

/// A console that answers every request with one body, recording the raw requests.
fn one_answer(status: u16, body: &'static str) -> (String, std::sync::mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!(
        "http://127.0.0.1:{}",
        listener.local_addr().expect("addr").port()
    );
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
            let reply = format!(
                "HTTP/1.1 {status} X\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    (url, rx)
}

#[test]
fn input_is_untagged_and_refused_replies_fail() {
    let (url, requests) = one_answer(200, "{}");
    Console::new(&url, Some("secret".into()))
        .expect("console")
        .send("abc-1", "hello")
        .expect("sent");
    let raw = requests.recv().expect("request");
    assert!(
        raw.starts_with("POST /api/v1/sessions/abc-1/input HTTP/1.1\r\n"),
        "{raw}"
    );
    assert!(
        raw.contains("\r\nX-Reverie-Service-Token: secret\r\n"),
        "{raw}"
    );
    assert!(
        raw.ends_with("\r\n\r\n{\"input\": \"hello\\r\", \"useMux\": true}"),
        "{raw}"
    );
    for body in [
        "{\"buffered\": true}",
        "{\"dropped\": 1}",
        "{\"duplicate\": \"yes\"}",
        "[]",
        "{\"success\": false}",
    ] {
        let body: &'static str = Box::leak(body.to_string().into_boxed_str());
        let (url, _) = one_answer(200, body);
        assert!(
            Console::new(&url, Some("t".into()))
                .expect("console")
                .send("a1", "x")
                .is_err(),
            "{body}"
        );
    }
    let (url, _) = one_answer(200, "{\"success\": true, \"data\": null}");
    assert!(
        Console::new(&url, Some("t".into()))
            .expect("console")
            .send("a1", "x")
            .is_ok()
    );
}

#[test]
fn redirects_are_never_followed() {
    let (url, requests) = one_answer(302, "");
    assert!(
        Console::new(&url, Some("t".into()))
            .expect("console")
            .sessions()
            .is_err()
    );
    assert!(requests.recv().is_ok());
    assert!(requests.try_recv().is_err(), "a redirect was followed");
}

#[test]
fn floats_print_as_python_prints_them() {
    for (x, s) in [
        (1_792_155_000.0, "1792155000.0"),
        (1_792_155_000.5, "1792155000.5"),
        (0.1, "0.1"),
        (1e16, "1e+16"),
        (1e-5, "1e-05"),
        (-0.0, "-0.0"),
        (123.456, "123.456"),
    ] {
        assert_eq!(py_float(x), s);
    }
}

#[test]
fn json_keeps_order_kinds_and_last_duplicate() {
    let value = json::parse("{\"b\": 1, \"a\": 2.0, \"b\": 3}").expect("json");
    assert_eq!(
        value,
        Json::Obj(vec![
            ("b".into(), Json::Int(3)),
            ("a".into(), Json::Float(2.0))
        ])
    );
    assert_eq!(json::dump(&value), "{\"b\": 3, \"a\": 2.0}");
    assert!(json::parse(&"[".repeat(5000)).is_err());
}

#[test]
fn zone_keys_follow_python_rules() {
    assert!(load_zone("America/Chicago").is_some());
    for key in [
        "",
        "/etc/localtime",
        "../x",
        "America//Chicago",
        "America/",
        "./UTC",
        "america/chicago",
        "America",
    ] {
        assert!(load_zone(key).is_none(), "{key}");
    }
}
