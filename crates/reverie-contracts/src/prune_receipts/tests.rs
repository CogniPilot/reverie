use super::text::{is_id, is_sha, is_utc, utc};
use super::*;

fn codes(text: &str) -> Vec<u32> {
    text.chars().map(u32::from).collect()
}

#[test]
fn identifier_patterns_allow_one_final_newline_like_python_dollar() {
    for good in ["a", "A1._:-z", "run-1\n", &format!("a{}", "b".repeat(63))] {
        assert!(is_id(&codes(good)), "{good:?}");
    }
    for bad in [
        "",
        "-a",
        "a b",
        "a\n\n",
        "../x",
        "é",
        &format!("a{}", "b".repeat(64)),
    ] {
        assert!(!is_id(&codes(bad)), "{bad:?}");
    }
    assert!(is_sha(&codes(&format!("{}\n", "e".repeat(64)))));
    assert!(!is_sha(&codes(&"E".repeat(64))));
    assert!(is_utc(&codes("2026-10-25T16:05:00Z")) && is_utc(&codes("2026-10-25T16:05:00Z\n")));
    assert!(!is_utc(&codes("2026-10-25 16:05:00Z")));
}

#[test]
fn universal_newlines_and_python_blank_lines() {
    assert_eq!(universal_lines("a\r\nb\rc\nd"), ["a\n", "b\n", "c\n", "d"]);
    assert!(text::python_blank(" \u{a0}\u{1c}\n") && !text::python_blank(" x "));
}

#[test]
fn gmtime_strftime_and_its_errors() {
    assert_eq!(utc(0.0), Ok("1970-01-01T00:00:00Z".to_owned()));
    assert_eq!(utc(1_761_408_000.9), Ok("2025-10-25T16:00:00Z".to_owned()));
    assert_eq!(utc(-0.5), Ok("1969-12-31T23:59:59Z".to_owned()));
    assert_eq!(utc(f64::NAN), Err(RetainError::Crash(Crash("ValueError"))));
    assert_eq!(
        utc(f64::INFINITY),
        Err(RetainError::Crash(Crash("OverflowError")))
    );
    assert_eq!(utc(1e18), Err(RetainError::Os));
}

#[test]
fn command_line_numbers_follow_int_and_float() {
    assert_eq!(python_int(" 1_000 "), Some(1000));
    assert_eq!(python_int("-5"), Some(-5));
    for bad in ["", "1.0", "_1", "1_", "x"] {
        assert_eq!(python_int(bad), None, "{bad:?}");
    }
    assert_eq!(python_float("1_0.5"), Some(10.5));
    assert!(python_float("-inf").is_some_and(|value| value == f64::NEG_INFINITY));
    assert_eq!(python_float("e3"), None);
}

const RUN: &str = "20261025T160000Z-aaaa";

fn summary_record(body: &str) -> Result<Result<Receipt, Code>, Crash> {
    let name = codes(&format!("{RUN}.summary.json"));
    let context = Context::load(None).unwrap().0;
    from_summary(
        &name,
        body.as_bytes(),
        &Reference::of(body.as_bytes()),
        &context,
    )
}

fn line(extra: &str) -> String {
    summary_record(&format!(r#"{{"run_id": "{RUN}", "mode": "dry"{extra}}}"#))
        .unwrap()
        .unwrap()
        .line
}

#[test]
fn receipt_id_hashes_the_default_json_dumps_of_its_identity() {
    let receipt = summary_record(&format!(r#"{{"run_id": "{RUN}", "mode": "dry"}}"#))
        .unwrap()
        .unwrap();
    let identity = format!(r#"{{"event_kind": "PRUNE_OBSERVATION", "run_id": "{RUN}"}}"#);
    assert_eq!(receipt.id, hex(&Sha256::digest(identity.as_bytes())));
    assert!(
        receipt
            .line
            .starts_with(r#"{"actor_ref":"UNAVAILABLE","code":"RUN_EXIT_UNKNOWN""#)
    );
}

#[test]
fn summary_fields_follow_python_int_and_truthiness_rules() {
    // A boolean is an int: False is exit 0 and True is exit 1.
    assert!(line(r#", "exit": false"#).contains(r#""code":"RUN_OK""#));
    assert!(line(r#", "exit": false"#).contains(r#""exit":false"#));
    assert!(line(r#", "exit": true"#).contains(r#""code":"RUN_FAILED""#));
    assert!(line(r#", "exit": 1.0"#).contains(r#""code":"RUN_EXIT_UNKNOWN""#));
    assert!(line(r#", "exit": -0"#).contains(r#""exit":0,"#));
    assert!(line(r#", "ceiling_hit": NaN"#).contains(r#""ceiling_hit":true"#));
    assert!(line(r#", "ceiling_hit": "0""#).contains(r#""ceiling_hit":true"#));
    assert!(line(r#", "ceiling_hit": 0.0"#).contains(r#""ceiling_hit":false"#));
    assert!(
        line(r#", "passes": ["leases", 5, "bogus", "leases"]"#)
            .contains(r#""passes":["leases","leases"]"#)
    );
    let body = |extra: &str| format!(r#"{{"run_id": "{RUN}", "mode": "dry"{extra}}}"#);
    assert_eq!(
        summary_record(&body(r#", "by_decision": {"SKIP": true}"#)),
        Ok(Err("FIELD_OUT_OF_BOUNDS"))
    );
    assert_eq!(
        summary_record(&body(r#", "deleted_or_would_bytes": 9007199254740992"#)),
        Ok(Err("FIELD_OUT_OF_BOUNDS"))
    );
    assert_eq!(
        summary_record(&body(r#", "by_decision": [1]"#)),
        Err(Crash("AttributeError"))
    );
    assert_eq!(
        summary_record(&body(r#", "passes": 5"#)),
        Err(Crash("TypeError"))
    );
}

#[test]
fn context_rejects_each_invalid_field_and_binding() {
    let (_, rejected) =
        Context::load(Some(r#"{"admissions": {"r1": 5, "bad id": {}, "ok": {"lease_id": "x y"}}, "actor_ref": 7, "host_key": null}"#)).unwrap();
    assert_eq!(
        rejected,
        ["actor_ref", "admissions", "admissions", "admissions"]
    );
    assert_eq!(
        Context::load(Some("[1]")).err(),
        Some(Crash("AttributeError"))
    );
    assert_eq!(
        Context::load(Some(r#"{"admissions": [1]}"#)).err(),
        Some(Crash("AttributeError"))
    );
}

fn a1_run_id(since: &str) -> String {
    let report = format!(
        r#"{{"tool": "prune_exceptions", "window": {{"since": {since}}}, "generated_utc": "2026-11-07T17:00:00Z"}}"#
    );
    let context = Context::load(None).unwrap().0;
    let receipt = from_a1(
        report.as_bytes(),
        &Reference::of(report.as_bytes()),
        &context,
    )
    .unwrap()
    .unwrap();
    let start = receipt.line.find(r#""run_id":""#).unwrap() + 10;
    receipt.line[start..].split('"').next().unwrap().to_owned()
}

/// Nested window strings use `repr`, which only matters through the digits
/// of its escapes. ASCII and Latin-1 controls and lone surrogates match
/// Python. Other non-printable characters are a documented difference: for
/// `["\u2028"]` Python's run id is `a1-2028-20261107T170000Z` (oracle in the
/// packet), and this one keeps no digits for it.
#[test]
fn nested_window_strings_keep_the_digits_of_latin1_and_surrogate_escapes() {
    assert_eq!(a1_run_id(r#"["\u0085"]"#), "a1-85-20261107T170000Z");
    assert_eq!(a1_run_id(r#"["\u00a0T"]"#), "a1-0T-20261107T170000Z");
    assert_eq!(a1_run_id(r#"["\ud800"]"#), "a1-800-20261107T170000Z");
    assert_eq!(a1_run_id(r#"["\u2028"]"#), "a1--20261107T170000Z");
    assert_eq!(a1_run_id(r#""\u2028""#), "a1--20261107T170000Z");
}
