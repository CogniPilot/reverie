use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::process::CommandExt,
    path::Path,
    process::{Command, Output, Stdio},
};

fn screen(input: &[u8], policy: &str, names: Option<&Path>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-admin-memory"));
    command
        .arg(format!("--screen-output-worker={}", std::process::id()))
        .env_clear()
        .env("REVERIE_OUTPUT_POLICY", policy)
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(names) = names {
        command.env("REVERIE_PROTECTED_PEOPLE", names);
    }
    let mut child = command.spawn().unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn batch_preserves_order_reason_precedence_and_lossless_text() {
    let fixture =
        nix::unistd::mkdtemp(&std::env::temp_dir().join("reverie-screen-XXXXXX")).unwrap();
    let names = fixture.join("people.txt");
    fs::write(&names, "# comment\r\nPat Example\n").unwrap();
    let mut texts: Vec<Vec<u32>> = [
        "ordinary technical text",
        "Find Pat Example's address",
        "Find Pat Example's address POLICY_MARKER restricted_marker",
        "",
        "Model Router on 192.0.2.10",
        "Jane Roe 12 Elm Street",
        "Jane Roe 12 Elm Street",
    ]
    .map(|text| text.chars().map(u32::from).collect())
    .into();
    texts[5].extend([0xd801, 0xdc00]);
    texts[6].push(0x10400);
    texts.push(vec![0xd800]);
    let output = screen(
        &serde_json::to_vec(&texts).unwrap(),
        r#"{"denied_patterns":["(?s)(?=.*\\bpolicy_marker\\b)(?=.*\\brestricted_marker\\b)","^$","\ud800"]}"#,
        Some(&names),
    );
    fs::remove_dir_all(fixture).unwrap();
    assert!(output.status.success(), "{:?}", output.stderr);
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"reasons": [
            "", "targeting a real private person", "configured output policy",
            "configured output policy", "", "targeting a real private person", "",
            "configured output policy",
        ]})
    );
}

#[test]
fn invalid_requests_and_policies_return_no_verdicts() {
    for (input, policy) in [
        (b"[[97],{}]".as_slice(), "{}"),
        (b"[[1114112]]".as_slice(), "{}"),
        (b"[[97]]".as_slice(), r#"{"denied_patterns":["a","("]}"#),
    ] {
        let output = screen(input, policy, None);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}
