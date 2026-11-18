use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};

fn setup(fixture: &Fixture, cmd: &mut Command) {
    cmd.env("REVERIE_DATA_DIR", &fixture.0)
        .env("REVERIE_HANDS_MODEL", "selected-model")
        .env("REVERIE_HANDS_BASE_URL", "http://model.test/v1///")
        .env_remove("REVERIE_USERNAME")
        .args([
            "--hands-launch",
            "echo",
            "/fixture/agent_loop.py",
            "--no-tui",
            "--once",
        ]);
}

fn directory(fixture: &Fixture) -> PathBuf {
    let directory = fixture.0.join("hands/session-123");
    fs::create_dir_all(&directory).unwrap();
    directory
}

fn private_write(path: &Path, content: &str) {
    fs::write(path, content).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn hands_waits_for_the_exact_office_employee_and_execs_the_existing_runtime() {
    let fixture = Fixture::create();
    let directory = directory(&fixture);
    private_write(&directory.join("state.json"), r#"{"saved_cursor":"keep"}"#);
    private_write(
        &directory.join("runtime-settings.json"),
        r#"{"reply_max_tokens":16384,"model_timeout_s":900,"prompt_cap_chars":120000,"vision":true}"#,
    );
    let employee = json!({"sessionId":"session-123","name":"Selected employee","personality":"Owner-selected personality"});
    let (output, requests) = fixture.run_sequence(
        vec![
            ("503 Unavailable".into(), json!({})),
            ("200 OK".into(), json!({"data": {"employees": [{"sessionId":"session-123-other","name":"Foreign name"}]}})),
            ("200 OK".into(), json!({"data": {"employees": [employee]}})),
        ],
        |cmd| setup(&fixture, cmd),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!(
            "-I -B /fixture/agent_loop.py {} --no-tui --once\n",
            directory.join("agent.json").display()
        )
    );
    for request in requests {
        assert!(request.starts_with("GET /office/api/company HTTP/"));
        assert!(request.contains("X-Reverie-Parent-Session: session-123\r\n"));
        assert!(request.contains("Authorization: Basic b3duZXI6Zml4dHVyZQ==\r\n"));
    }
    let config: Value =
        serde_json::from_slice(&fs::read(directory.join("agent.json")).unwrap()).unwrap();
    assert_eq!(config["self_session_id"], "session-123");
    assert_eq!(config["self_name"], "Selected employee");
    assert_eq!(config["model"], "selected-model");
    assert_eq!(config["api_base"], "http://model.test/v1");
    assert_eq!(config["reply_max_tokens"], 16384);
    assert_eq!(config["prompt_cap_chars"], 120000);
    assert_eq!(config["vision"], true);
    assert_eq!(config["phone_wake"], true);
    assert_eq!(config["attachments_root"], "/reverie_workspace/attachments");
    assert!(config.get("temperature").is_none());
    let memory_file = directory.join("memory-instance.json");
    let memory: Value = serde_json::from_slice(&fs::read(&memory_file).unwrap()).unwrap();
    assert_eq!(memory["id"], "session-123");
    assert_eq!(memory["persona"], "Owner-selected personality");
    assert!(
        fs::read_to_string(directory.join("profile.txt"))
            .unwrap()
            .starts_with("You are Selected employee,")
    );
    for name in ["agent.json", "profile.txt", "memory-instance.json"] {
        assert_eq!(
            fs::metadata(directory.join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    private_write(&memory_file, "saved memory configuration");
    let (output, _) = fixture.run(
        "200 OK",
        json!({"data":{"employees":[{"sessionId":"session-123","name":"Renamed employee"}]}}),
        |cmd| setup(&fixture, cmd),
    );
    assert!(output.status.success());
    assert_eq!(
        fs::read_to_string(memory_file).unwrap(),
        "saved memory configuration"
    );
    assert_eq!(
        fs::read_to_string(directory.join("state.json")).unwrap(),
        r#"{"saved_cursor":"keep"}"#
    );
}

#[test]
fn hands_refuses_office_denial_and_private_settings_aliases() {
    let fixture = Fixture::create();
    let (output, _) = fixture.run("403 Forbidden", json!({}), |cmd| setup(&fixture, cmd));
    assert_refused(&output, "Reverie API rejected");
    let directory = directory(&fixture);
    assert!(!directory.join("agent.json").exists());
    let settings = directory.join("runtime-settings.json");
    let foreign = fixture.0.join("foreign.json");
    private_write(&foreign, r#"{"reply_max_tokens":16384}"#);
    symlink(&foreign, &settings).unwrap();
    let mut command = fixture.command("http://127.0.0.1:1");
    setup(&fixture, &mut command);
    assert_refused(&command.output().unwrap(), "owned private regular file");
    assert_eq!(
        fs::read_to_string(&foreign).unwrap(),
        r#"{"reply_max_tokens":16384}"#
    );
    assert!(!directory.join("agent.json").exists());
    fs::remove_file(settings).unwrap();
    symlink(&foreign, directory.join("agent.json")).unwrap();
    assert_refused(
        &command.output().unwrap(),
        "Private Hands data directory unavailable",
    );
    assert!(!directory.join("profile.txt").exists());
}

#[test]
fn hands_help_needs_no_office_or_python() {
    let output = Command::new(PROGRAM)
        .env_clear()
        .args([
            "--hands-launch",
            "/missing/interpreter",
            "/missing/runtime",
            "--help",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("Reverie Admin Harness")
    );
}
