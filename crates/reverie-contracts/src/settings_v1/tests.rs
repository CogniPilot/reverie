use super::*;

fn answer(file: &str) -> (u16, ContentType, String) {
    let response = respond(Some(file.as_bytes())).expect("answered");
    (
        response.status,
        response.content_type,
        String::from_utf8(response.body).expect("UTF-8 body"),
    )
}

fn json(status: u16, body: &str) -> (u16, ContentType, String) {
    (status, ContentType::Json, body.to_string())
}

/// Each expectation is the probe's recorded Fastify 5.8.5 answer (spec r3 probe/RESULTS.json).
#[test]
fn answers_match_the_recorded_route() {
    let empty = r#"{"success":true,"data":{}}"#;
    let cases: &[(&str, (u16, ContentType, String))] = &[
        ("", json(200, empty)),
        ("\u{feff}{}", json(200, empty)),
        (
            r#"{"b":1,"1":2,"a":3,"0":4}"#,
            json(200, r#"{"success":true,"data":{"0":4,"1":2,"b":1,"a":3}}"#),
        ),
        ("[1,2]", json(200, r#"{"success":true,"data":[1,2]}"#)),
        ("5", json(200, "5")),
        ("true", json(200, "true")),
        ("null", json(200, "null")),
        (
            r#""hello""#,
            (200, ContentType::PlainText, "hello".to_string()),
        ),
        (
            r#""{\"x\":1}""#,
            (200, ContentType::PlainText, r#"{"x":1}"#.to_string()),
        ),
        (
            r#"{"success":true,"x":1}"#,
            json(200, r#"{"success":true,"x":1}"#),
        ),
        (r#"{"success":false}"#, json(200, r#"{"success":false}"#)),
        (
            r#"{"success":false,"errorCode":"NOT_FOUND"}"#,
            json(404, r#"{"success":false,"errorCode":"NOT_FOUND"}"#),
        ),
        (
            r#"{"success":false,"errorCode":"NOPE"}"#,
            json(400, r#"{"success":false,"errorCode":"NOPE"}"#),
        ),
        (
            r#"{"success":false,"errorCode":5}"#,
            json(200, r#"{"success":false,"errorCode":5}"#),
        ),
        (
            r#"{"success":null}"#,
            json(200, r#"{"success":true,"data":{"success":null}}"#),
        ),
        (
            r#"{"success":"false"}"#,
            json(200, r#"{"success":true,"data":{"success":"false"}}"#),
        ),
        (
            r#"{"success":true,"success":1}"#,
            json(200, r#"{"success":true,"data":{"success":1}}"#),
        ),
        (
            r#"{"success":1,"success":false,"errorCode":"NOT_FOUND"}"#,
            json(404, r#"{"success":false,"errorCode":"NOT_FOUND"}"#),
        ),
        (
            r#"{"__proto__":{"x":1}}"#,
            json(200, r#"{"success":true,"data":{"__proto__":{"x":1}}}"#),
        ),
        (
            "[1e21,1e-7,0.000001,5e-324,1e400,-0,12345678901234567890,0.1]",
            json(
                200,
                r#"{"success":true,"data":[1e+21,1e-7,0.000001,5e-324,null,0,12345678901234567000,0.1]}"#,
            ),
        ),
    ];
    for (file, expected) in cases {
        assert_eq!(answer(file), *expected, "{file:?}");
    }
}

#[test]
fn inherited_error_codes_keep_their_legacy_500() {
    let prefix = r#"{"success":false,"error":"Called reply with an invalid status code: "#;
    for (name, shown) in [
        ("toString", "function toString() { [native code] }"),
        ("constructor", "function Object() { [native code] }"),
        ("valueOf", "function valueOf() { [native code] }"),
        ("__proto__", "[object Object]"),
        (
            "hasOwnProperty",
            "function hasOwnProperty() { [native code] }",
        ),
    ] {
        let file = format!(r#"{{"success":false,"errorCode":"{name}"}}"#);
        assert_eq!(
            answer(&file),
            json(
                500,
                &format!(r#"{prefix}{shown}","errorCode":"OPERATION_FAILED"}}"#)
            ),
            "{name}"
        );
    }
}

#[test]
fn a_read_failure_is_the_default_and_the_bounds_refuse() {
    assert_eq!(
        respond(None).map(|response| response.body),
        Ok(br#"{"success":true,"data":{}}"#.to_vec())
    );
    assert_eq!(
        respond(Some(&vec![b' '; MAX_FILE_BYTES + 1])),
        Err(Refusal::FileBound)
    );
    assert!(respond(Some(&vec![b' '; MAX_FILE_BYTES])).is_ok());
    // A fixed 2002-byte input far below both size bounds, so only the depth bound can refuse it.
    let deep = "[".repeat(MAX_DEPTH + 1) + &"]".repeat(MAX_DEPTH + 1);
    assert_eq!(respond(Some(deep.as_bytes())), Err(Refusal::DepthBound));
    let deepest = "[".repeat(MAX_DEPTH) + &"]".repeat(MAX_DEPTH);
    assert_eq!(respond(Some(deepest.as_bytes())).map(|r| r.status), Ok(200));
    // Stack safety with the bound in place: 100,000 levels (200 KB) refuse without recursion.
    let far = "[".repeat(100_000) + &"]".repeat(100_000);
    assert_eq!(respond(Some(far.as_bytes())), Err(Refusal::DepthBound));
}

#[test]
fn invalid_utf8_decodes_as_node_does() {
    // A lone continuation byte inside a string becomes U+FFFD, then the string is literal UTF-8.
    let response = respond(Some(b"[\"a\x80b\"]")).expect("answered");
    assert_eq!(
        response.body,
        "{\"success\":true,\"data\":[\"a\u{fffd}b\"]}".as_bytes()
    );
}

#[test]
fn requests_name_exactly_the_settings_path() {
    assert_eq!(
        decode_request(br#"{"settingsPath":"/data/settings.json"}"#),
        Ok(Request {
            settings_path: "/data/settings.json".to_string()
        })
    );
    for raw in [
        &br#"{}"#[..],
        br#"{"settingsPath":""}"#,
        br#"{"settingsPath":1}"#,
        br#"{"settingsPath":"a","x":1}"#,
        br#"["a"]"#,
        b"\xff",
    ] {
        assert_eq!(decode_request(raw), Err(Refusal::RequestSchema), "{raw:?}");
    }
}

#[test]
fn the_route_statuses_are_the_fixture_ones() {
    let route = crate::route_frames_v1::route(crate::route_frames_v1::SETTINGS).expect("route");
    assert_eq!(route.statuses, statuses().as_slice());
}
