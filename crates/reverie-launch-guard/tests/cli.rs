use reverie_contracts::launch_guard::{INPUT_LIMIT, Receipt};
use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

const EXAMPLE: &[u8] = include_bytes!("../../../examples/launch-guard-input.json");
const INVALID: &[u8] =
    b"{\"code\":\"GUARD_INPUT_INVALID\",\"result\":\"REFUSE\",\"schema_version\":1}\n";

fn command(args: &[&str], input: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_reverie-launch-guard"))
        .args(args)
        .env_clear()
        .env("PYTHONPATH", "/nonexistent-python-path")
        .env("PYTHONHOME", "/nonexistent-python-home")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn example_and_help_need_no_ambient_interpreter() {
    let example = command(&["--example"], b"ignored");
    assert!(example.status.success());
    assert_eq!(example.stdout, EXAMPLE);
    let evaluated = command(&[], EXAMPLE);
    assert!(evaluated.status.success());
    assert!(evaluated.stderr.is_empty());
    assert!(Receipt::decode(&evaluated.stdout).unwrap().passed());
    let help = command(&["--help"], b"invalid");
    assert!(help.status.success());
    assert!(help.stdout.starts_with(b"Usage: reverie-launch-guard"));
    for args in [
        ["--live"].as_slice(),
        &["--help", "extra"],
        &[""],
        &["--example", "extra"],
        &["--apply"],
    ] {
        let refused = command(args, EXAMPLE);
        assert_eq!(refused.status.code(), Some(2));
        assert!(refused.stdout.is_empty());
    }
}

#[test]
fn validated_refusal_keeps_its_reason_and_exit_status() {
    let mut input: Value = serde_json::from_slice(EXAMPLE).unwrap();
    input["request"]["currentGoalGeneration"] = json!(2);
    let output = command(&[], &serde_json::to_vec(&input).unwrap());
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stderr.is_empty());
    assert!(!Receipt::decode(&output.stdout).unwrap().passed());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["code"], "GUARD_GEN_CHANGED");
}

#[test]
fn malformed_bytes_emit_one_fixed_diagnostic_without_echoing_input() {
    for payload in [
        br#"{"request":{},"request":{},"now_ms":0}"#.as_slice(),
        br#"{"request":NaN,"now_ms":0}"#,
        br#"{"request":{"prompt":"DO_NOT_ECHO_SYNTHETIC_SECRET"},"now_ms":0}"#,
        &vec![b' '; INPUT_LIMIT + 1],
    ] {
        let output = command(&[], payload);
        assert_eq!(output.status.code(), Some(2));
        assert_eq!(output.stdout, INVALID);
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn duplicated_cursor_keys_refuse_after_unescaping() {
    let text = std::str::from_utf8(EXAMPLE).unwrap();
    let input = text.replace(r#""room-1": 10"#, r#""room-1": 10, "\u0072oom-1": 10"#);
    assert_ne!(input, text);
    let output = command(&[], input.as_bytes());
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(output.stdout, INVALID);
}

#[test]
fn compatible_json_byte_encodings_emit_identical_receipts() {
    let expected = command(&[], EXAMPLE).stdout;
    let text = std::str::from_utf8(EXAMPLE).unwrap();
    let utf16le: Vec<_> = [0xff, 0xfe]
        .into_iter()
        .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
        .collect();
    let utf32be: Vec<_> = text
        .chars()
        .map(u32::from)
        .flat_map(u32::to_be_bytes)
        .collect();
    for raw in [utf16le, utf32be, [b"\xef\xbb\xbf", EXAMPLE].concat()] {
        let output = command(&[], &raw);
        assert!(output.status.success());
        assert_eq!(output.stdout, expected);
    }
}
