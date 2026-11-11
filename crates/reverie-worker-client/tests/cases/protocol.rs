use crate::support::*;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::time::{Duration, Instant};

#[test]
fn storage_status_is_discoverable_without_connecting_or_selecting_a_session() {
    let tree = Tree::new();
    let output = Process::spawn(&mut tree.command(&["--help"])).wait();
    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).unwrap();
    assert!(help.contains("storage-status"));
    tree.no_connection();
}

#[test]
fn launch_attach_and_resource_frames_preserve_stdio_and_environment() {
    for mode in ["normal", "attach", "resource"] {
        let tree = Tree::new();
        let mut args = vec![
            "--session-id",
            SID,
            "--cwd",
            "/workspace/λ",
            "--command",
            "printf 'λ'",
        ];
        if mode == "attach" {
            args.push("--attach-only");
        }
        if mode == "resource" {
            args.extend(["--resource-ref", SID]);
        }
        let mut child = Process::spawn(
            tree.command(&args)
                .env("CODEX_PROFILE", "λ")
                .env("REVERIE_HOOK_GENERATION", "private-launch-generation")
                .env("REVERIE_HOOK_GENERATION_EXTRA", "not-a-generation-key")
                .env("PATH", "/secret")
                .env("REVERIE_OWNER_TOKEN", "never"),
        );
        let mut broker = tree.accept();
        let (kind, raw) = receive(&mut broker);
        assert_eq!(kind, if mode == "resource" { b'L' } else { b'J' });
        let outer: Value = serde_json::from_slice(&raw).unwrap();
        let request = if mode == "resource" {
            assert_eq!(outer["reference"], SID);
            &outer["request"]
        } else {
            &outer
        };
        assert_eq!(
            request["env"],
            json!({"CODEX_PROFILE":"λ", "REVERIE_HOOK_GENERATION":"private-launch-generation"})
        );
        assert_eq!(request["cols"], 120);
        assert_eq!(request["rows"], 40);
        assert_eq!(request["cwd"], "/workspace/λ");
        assert_eq!(request["command"], "printf 'λ'");
        assert_eq!(
            request.get("attachOnly"),
            if mode == "attach" {
                Some(&Value::Bool(true))
            } else {
                None
            }
        );
        child
            .child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"input\0bytes")
            .unwrap();
        assert_eq!(receive(&mut broker), (b'I', b"input\0bytes".to_vec()));
        send(&mut broker, b'O', b"output\0bytes");
        send(&mut broker, b'X', b"37");
        let output = child.wait();
        assert_eq!(output.status.code(), Some(37));
        assert_eq!(output.stdout, b"output\0bytes");
        assert!(output.stderr.is_empty());
    }
}
#[test]
fn all_control_verbs_and_stop_fences_are_sent_once_with_existing_shape() {
    for action in [
        "status",
        "provider-health",
        "storage-status",
        "stop-laptops",
        "shutdown",
        "restart-website",
        "reload-resources",
        "stop-agent",
        "settle-stop",
    ] {
        let tree = Tree::new();
        let mut args = vec!["--control", action];
        let fence = "a1234567890123456789012345678901";
        if ["stop-agent", "settle-stop"].contains(&action) {
            args.extend(["--session-id", SID, "--fence", fence]);
        }
        if action == "stop-agent" {
            args.extend(["--not-after", "1900000000000"]);
        }
        let child = Process::spawn(&mut tree.command(&args));
        let mut broker = tree.accept();
        let (kind, raw) = receive(&mut broker);
        assert_eq!(kind, b'C');
        let request: Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(request["action"], action);
        if ["stop-agent", "settle-stop"].contains(&action) {
            assert_eq!(request["sessionId"], SID);
            assert_eq!(request["fence"], fence);
        }
        if action == "stop-agent" {
            assert_eq!(request["notAfter"], 1_900_000_000_000_i64);
        }
        send(&mut broker, b'J', br#"{"success":true}"#);
        let output = child.wait();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"{\"success\":true}\n");
        let mut extra = [0];
        assert_eq!(broker.read(&mut extra).unwrap(), 0);
    }
}
#[test]
fn malformed_modes_and_invalid_utf8_arguments_refuse_before_connect() {
    let tree = Tree::new();
    for args in [
        vec!["--control", "storage-status", "--session-id", SID],
        vec!["--control", "storage-status", "--caller-session", SID],
        vec!["--control", "storage-status", "--command", "secret-command"],
        vec!["--resource-ref", "bad"],
        vec!["--resource-ref", SID, "--control", "status"],
        vec!["--resource-ref", SID, "--attach-only"],
        vec!["--goal-custody-stream", "--caller-session", SID],
        vec!["--control", "settle-stop", "--session-id", SID],
        vec![
            "--control",
            "stop-agent",
            "--session-id",
            SID,
            "--fence",
            "a1234567890123456789012345678901",
        ],
        vec![
            "--command-failure-report",
            "--employee-id",
            SID,
            "--employee-id",
            SID,
        ],
    ] {
        assert!(
            !Process::spawn(&mut tree.command(&args))
                .wait()
                .status
                .success()
        );
        tree.no_connection();
    }
    let mut command = tree.command(&["--session-id", SID, "--cwd", "/workspace", "--command"]);
    command.arg(std::ffi::OsString::from_vec(vec![0xff]));
    assert_eq!(Process::spawn(&mut command).wait().status.code(), Some(2));
    tree.no_connection();
}
#[test]
fn custody_once_and_repeated_bare_g_stream_have_exact_closed_frames() {
    let tree = Tree::new();
    let mut child = Process::spawn(&mut tree.command(&["--goal-custody-stream"]));
    child
        .child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"GG")
        .unwrap();
    drop(child.child.stdin.take());
    for _ in 0..2 {
        let mut broker = tree.accept();
        assert_eq!(
            receive(&mut broker),
            (b'G', br#"{"action":"goal-custody"}"#.to_vec())
        );
        send(&mut broker, b'J', &serde_json::to_vec(&custody()).unwrap());
    }
    let output = child.wait();
    assert!(output.status.success(), "{:?}", output.stderr);
    let mut cursor = std::io::Cursor::new(output.stdout);
    for _ in 0..2 {
        let mut header = [0; 5];
        cursor.read_exact(&mut header).unwrap();
        assert_eq!(header[0], b'J');
        let mut bytes = vec![0; u32::from_be_bytes(header[1..].try_into().unwrap()) as usize];
        cursor.read_exact(&mut bytes).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), custody());
    }
    assert_eq!(cursor.position(), cursor.get_ref().len() as u64);
    let child = Process::spawn(&mut tree.command(&["--goal-custody"]));
    let mut broker = tree.accept();
    receive(&mut broker);
    send(&mut broker, b'J', &serde_json::to_vec(&custody()).unwrap());
    let output = child.wait();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        custody()
    );
}
#[test]
fn custody_bad_operation_private_mode_and_rebound_endpoint_publish_nothing() {
    let tree = Tree::new();
    let mut child = Process::spawn(&mut tree.command(&["--goal-custody-stream"]));
    child.child.stdin.as_mut().unwrap().write_all(b"X").unwrap();
    let output = child.wait();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    tree.no_connection();
    std::fs::set_permissions(&tree.socket, std::fs::Permissions::from_mode(0o660)).unwrap();
    assert!(
        !Process::spawn(&mut tree.command(&["--goal-custody"]))
            .wait()
            .status
            .success()
    );
    tree.no_connection();
    std::fs::set_permissions(&tree.socket, std::fs::Permissions::from_mode(0o600)).unwrap();
    let child = Process::spawn(&mut tree.command(&["--goal-custody"]));
    let mut broker = tree.accept();
    receive(&mut broker);
    std::fs::rename(&tree.socket, tree.root.join("old.sock")).unwrap();
    let _new = std::os::unix::net::UnixListener::bind(&tree.socket).unwrap();
    std::fs::set_permissions(&tree.socket, std::fs::Permissions::from_mode(0o600)).unwrap();
    send(&mut broker, b'J', &serde_json::to_vec(&custody()).unwrap());
    let output = child.wait();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}
#[test]
fn fragmented_custody_response_never_renews_fixed_deadline() {
    let tree = Tree::new();
    let child = Process::spawn(&mut tree.command(&["--goal-custody"]));
    let mut broker = tree.accept();
    receive(&mut broker);
    let started = Instant::now();
    let bytes = serde_json::to_vec(&custody()).unwrap();
    broker.write_all(b"J").unwrap();
    std::thread::sleep(Duration::from_millis(1100));
    broker
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .unwrap();
    std::thread::sleep(Duration::from_millis(800));
    let output = child.wait();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(started.elapsed() < Duration::from_millis(2600));
}
#[test]
fn path_and_symlink_launches_normalize_exact_kernel_argv_without_new_pid() {
    let tree = Tree::new();
    let alias = tree.root.join("alias");
    symlink(BIN, &alias).unwrap();
    for via_path in [false, true] {
        let mut command = if via_path {
            std::process::Command::new("alias")
        } else {
            std::process::Command::new(&alias)
        };
        command
            .args(["--control", "status"])
            .env_clear()
            .env("REVERIE_WORKER_SOCKET", &tree.socket)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if via_path {
            command.env("PATH", &tree.root);
        }
        let child = Process::spawn(&mut command);
        let mut broker = tree.accept();
        receive(&mut broker);
        let proc = std::path::PathBuf::from(format!("/proc/{}", child.child.id()));
        assert_eq!(
            std::fs::read_link(proc.join("exe")).unwrap(),
            std::fs::canonicalize(BIN).unwrap()
        );
        let argv = std::fs::read(proc.join("cmdline")).unwrap();
        assert_eq!(
            argv.split(|b| *b == 0).next().unwrap(),
            std::fs::canonicalize(BIN)
                .unwrap()
                .as_os_str()
                .as_encoded_bytes()
        );
        send(&mut broker, b'J', b"{}");
        assert!(child.wait().status.success());
    }
}

#[test]
fn report_transport_validates_before_publishing_any_metadata() {
    let report = json!({"v":1,"enabled":false,"provenance":"SELF_REPORTED_RESULT","harness_support":{"hands":"self_reported","claude":"unavailable","codex":"unavailable"},"employees":[{"employee_id":SID,"harness":"hands","status":"disabled","counts":[],"truncated":false,"evicted":0,"expired":0,"dropped":0}],"top_repeats":[],"truncated":false});
    let valid = serde_json::to_string(&report).unwrap();
    for raw in [
        valid.clone(),
        valid.replace("\"v\":1", "\"v\":1.0"),
        valid.replace("\"v\":1", "\"v\":1,\"v\":1"),
        valid.replace("\"evicted\":0", "\"evicted\":0,\"evicted\":0"),
        valid.replace(SID, "00000000-0000-0000-0000-000000000000"),
    ] {
        let tree = Tree::new();
        let child =
            Process::spawn(&mut tree.command(&["--command-failure-report", "--employee-id", SID]));
        let mut broker = tree.accept();
        let (kind, request) = receive(&mut broker);
        assert_eq!(kind, b'T');
        assert_eq!(
            serde_json::from_slice::<Value>(&request).unwrap(),
            json!({"v":1,"action":"command-failures","employee_ids":[SID]})
        );
        send(&mut broker, b'J', raw.as_bytes());
        let output = child.wait();
        assert_eq!(output.status.success(), raw == valid);
        if raw == valid {
            assert_eq!(
                serde_json::from_slice::<Value>(&output.stdout).unwrap(),
                report
            );
        } else {
            assert!(output.stdout.is_empty());
        }
    }
}

#[test]
fn oversized_truncated_and_invalid_frames_refuse_without_partial_output() {
    for hazard in ["oversized", "truncated", "float-exit", "unknown"] {
        let tree = Tree::new();
        let child = Process::spawn(&mut tree.command(&[
            "--session-id",
            SID,
            "--cwd",
            "/workspace",
            "--command",
            "never executed",
        ]));
        let mut broker = tree.accept();
        receive(&mut broker);
        match hazard {
            "oversized" => {
                broker.write_all(b"O").unwrap();
                broker.write_all(&262_145_u32.to_be_bytes()).unwrap();
            }
            "truncated" => {
                broker.write_all(b"O\0\0\0\x06abc").unwrap();
            }
            "float-exit" => send(&mut broker, b'X', b"1.0"),
            _ => send(&mut broker, b'?', b""),
        }
        drop(broker);
        let output = child.wait();
        assert!(!output.status.success(), "{hazard}");
        assert!(output.stdout.is_empty());
        tree.no_connection();
    }
    for hazard in ["oversized", "wrong-kind", "invalid-utf8"] {
        let tree = Tree::new();
        let child = Process::spawn(&mut tree.command(&["--goal-custody"]));
        let mut broker = tree.accept();
        receive(&mut broker);
        match hazard {
            "oversized" => {
                broker.write_all(b"J").unwrap();
                broker.write_all(&32_769_u32.to_be_bytes()).unwrap();
            }
            "wrong-kind" => send(&mut broker, b'E', b"unavailable"),
            _ => send(&mut broker, b'J', b"\xff"),
        }
        let output = child.wait();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn lost_control_or_launch_reply_never_reconnects_or_resends() {
    for control in [true, false] {
        let tree = Tree::new();
        let args = if control {
            vec!["--control", "status"]
        } else {
            vec![
                "--resource-ref",
                SID,
                "--session-id",
                SID,
                "--cwd",
                "/workspace",
                "--command",
                "never executed",
            ]
        };
        let child = Process::spawn(&mut tree.command(&args));
        let mut broker = tree.accept();
        let (kind, _) = receive(&mut broker);
        assert_eq!(kind, if control { b'C' } else { b'L' });
        drop(broker);
        let output = child.wait();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        tree.no_connection();
    }
}

#[test]
fn invalid_utf8_allowlisted_environment_is_refused_without_a_launch_frame() {
    let tree = Tree::new();
    let mut command = tree.command(&[
        "--session-id",
        SID,
        "--cwd",
        "/workspace",
        "--command",
        "never executed",
    ]);
    command.env("CODEX_PROFILE", std::ffi::OsString::from_vec(vec![0xff]));
    let child = Process::spawn(&mut command);
    let mut broker = tree.accept();
    let output = child.wait();
    assert_eq!(output.status.code(), Some(1));
    let mut byte = [0];
    assert_eq!(broker.read(&mut byte).unwrap(), 0);
    assert!(output.stdout.is_empty());
}

#[test]
fn unrelated_non_utf8_environment_key_is_ignored_without_lossy_normalization() {
    let tree = Tree::new();
    let mut command = tree.command(&[
        "--session-id",
        SID,
        "--cwd",
        "/workspace",
        "--command",
        "never executed",
    ]);
    command
        .env(std::ffi::OsString::from_vec(vec![0xff]), "never forwarded")
        .env("LANG", "en_US.UTF-8");
    let child = Process::spawn(&mut command);
    let mut broker = tree.accept();
    let (kind, raw) = receive(&mut broker);
    assert_eq!(kind, b'J');
    let request: Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(request["env"], json!({"LANG":"en_US.UTF-8"}));
    send(&mut broker, b'X', b"0");
    assert!(child.wait().status.success());
}
