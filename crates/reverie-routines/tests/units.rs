//! The checks of python's tests/test_routines.py that are not a whole tick: fixed texts, the console client's refusals,
//! policy rules, and python's float and JSON behaviour.

use reverie_routines::console::{Console, decode_json_bytes};
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

/// Serves one reply with `body` on 127.0.0.1 and hands back the request it received.
fn one_reply(body: Vec<u8>) -> (String, std::sync::mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!(
        "http://127.0.0.1:{}",
        listener.local_addr().expect("addr").port()
    );
    let (sent, received) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        if let Some(mut stream) = listener.incoming().flatten().next() {
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let _ = sent.send(String::from_utf8_lossy(&buf[..n]).to_string());
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&body);
        }
    });
    (url, received)
}

#[test]
fn a_token_that_is_not_a_plain_header_value_is_refused_before_connecting() {
    // Python's http.client raised ValueError for CR or LF and sent nothing; no other header may ever be injected.
    for token in [
        "t\r\nX-Injected: 1",
        "t\nX-Injected: 1",
        "t\r",
        "t\u{0}",
        "t\u{7f}",
        "t\u{e9}",
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.set_nonblocking(true).expect("nonblocking");
        let url = format!(
            "http://127.0.0.1:{}",
            listener.local_addr().expect("addr").port()
        );
        let console = Console::new(&url, Some(token.into())).expect("console");
        assert!(console.sessions().is_err(), "{token:?}");
        assert_eq!(
            listener.accept().map(|_| ()).map_err(|e| e.kind()),
            Err(std::io::ErrorKind::WouldBlock),
            "{token:?} connected"
        );
    }
    // A plain token is sent once, as the only header of its kind; an empty one is not sent, as python skipped it.
    let (url, request) = one_reply(br#"{"data": []}"#.to_vec());
    assert_eq!(
        Console::new(&url, Some("abc-123 x".into()))
            .expect("console")
            .sessions()
            .expect("sessions"),
        Json::List(vec![])
    );
    let head = request.recv().expect("request");
    assert_eq!(
        head.matches("X-Reverie-Service-Token: abc-123 x\r\n")
            .count(),
        1
    );
    assert!(!head.contains("X-Injected"));
    let (url, request) = one_reply(br#"{"data": []}"#.to_vec());
    Console::new(&url, Some(String::new()))
        .expect("console")
        .sessions()
        .expect("sessions");
    assert!(
        !request
            .recv()
            .expect("request")
            .contains("X-Reverie-Service-Token")
    );
}

#[test]
fn replies_decode_as_json_loads_detects_their_encoding() {
    // Python 3.13 json.loads decoded each of these to the same object, and refused the last two (BOM-REFERENCE.txt).
    let p = "{\"data\": {\"s\": \"\u{e9}\u{1F600}\", \"n\": 1}}";
    let le16 = |s: &str| {
        s.encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<u8>>()
    };
    let be16 = |s: &str| {
        s.encode_utf16()
            .flat_map(u16::to_be_bytes)
            .collect::<Vec<u8>>()
    };
    let le32 = |s: &str| {
        s.chars()
            .flat_map(|c| (c as u32).to_le_bytes())
            .collect::<Vec<u8>>()
    };
    let be32 = |s: &str| {
        s.chars()
            .flat_map(|c| (c as u32).to_be_bytes())
            .collect::<Vec<u8>>()
    };
    let with = |bom: &[u8], rest: Vec<u8>| [bom.to_vec(), rest].concat();
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("utf-8", p.as_bytes().to_vec()),
        (
            "utf-8-bom",
            with(&[0xEF, 0xBB, 0xBF], p.as_bytes().to_vec()),
        ),
        ("utf-16-le-bom", with(&[0xFF, 0xFE], le16(p))),
        ("utf-16-be-bom", with(&[0xFE, 0xFF], be16(p))),
        ("utf-32-le-bom", with(&[0xFF, 0xFE, 0, 0], le32(p))),
        ("utf-32-be-bom", with(&[0, 0, 0xFE, 0xFF], be32(p))),
        ("utf-16-le", le16(p)),
        ("utf-16-be", be16(p)),
        ("utf-32-le", le32(p)),
        ("utf-32-be", be32(p)),
    ];
    for (name, bytes) in &cases {
        assert_eq!(decode_json_bytes(bytes).ok().as_deref(), Some(p), "{name}");
    }
    assert_eq!(decode_json_bytes(&be16("1")).ok().as_deref(), Some("1"));
    assert_eq!(decode_json_bytes(&le16("1")).ok().as_deref(), Some("1"));
    assert!(decode_json_bytes(&[le16(p), b"x".to_vec()].concat()).is_err());
    assert!(decode_json_bytes(b"{\"s\": \"\xff\"}").is_err());
    // Through the client: a UTF-16 reply with a BOM reads as its UTF-8 twin does.
    let (url, _request) = one_reply(with(&[0xFF, 0xFE], le16(p)));
    let got = Console::new(&url, None)
        .expect("console")
        .sessions()
        .expect("sessions");
    assert_eq!(Some(&got), json::parse(p).expect("parse").get("data"));
}

#[test]
fn a_lone_surrogate_escape_reads_as_the_replacement_character() {
    // Python kept the lone surrogate in the string; Rust strings cannot hold one, so it reads as U+FFFD (named difference).
    assert_eq!(
        json::parse("\"a\\ud800b\"").expect("parse"),
        Json::Str("a\u{FFFD}b".into())
    );
    assert_eq!(
        json::parse("\"\\udc00\"").expect("parse"),
        Json::Str("\u{FFFD}".into())
    );
    assert_eq!(
        json::parse("\"\\ud83d\\ude00\"").expect("parse"),
        Json::Str("\u{1F600}".into())
    );
}
