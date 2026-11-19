use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};

fn configure(fixture: &Fixture, cmd: &mut Command) {
    cmd.env("REVERIE_DATA_DIR", &fixture.0)
        .env("REVERIE_HANDS_MODEL", "selected-model")
        .env("REVERIE_HANDS_BASE_URL", "http://model.test/v1///")
        .env_remove("REVERIE_USERNAME");
}

fn setup(fixture: &Fixture, cmd: &mut Command) {
    configure(fixture, cmd);
    cmd.args([
        "--hands-launch",
        "--native-runtime",
        "echo",
        "--no-tui",
        "--once",
    ]);
}

#[test]
fn packaged_launcher_selects_native_hands_for_standard_and_coding_sessions() {
    let fixture = Fixture::create();
    let directory = directory(&fixture);
    for coding in [false, true] {
        if coding {
            private_write(
                &directory.join("runtime-settings.json"),
                r#"{"coding":{"root":"/workspace"}}"#,
            );
        }
        let (output, _) = fixture.run(
            "200 OK",
            json!({"data":{"employees":[{"sessionId":"session-123","name":"Selected employee"}]}}),
            |cmd| {
                configure(&fixture, cmd);
                cmd.args(["--hands-launch", "--native-runtime", "echo", "--once"]);
            },
        );
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!(
                "--hands-native {} --once\n",
                directory.join("agent.json").display()
            )
        );
        let config: Value =
            serde_json::from_slice(&fs::read(directory.join("agent.json")).unwrap()).unwrap();
        assert_eq!(!config["coding"].is_null(), coding);
    }
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
fn hands_waits_for_the_exact_office_employee_and_execs_the_native_runtime() {
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
            "--hands-native {} --no-tui --once\n",
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
            "--native-runtime",
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

#[test]
fn chat_continuity_reuses_the_existing_store_for_both_instance_selections() {
    let fixture = Fixture::create();
    let existing = fixture.0.join("selected-data");
    fs::create_dir(&existing).unwrap();
    let database = existing.join("memory.sqlite");
    fs::write(&database, b"preserve this store").unwrap();
    let existing_instance = fixture.0.join("selected.json");
    fs::write(
        &existing_instance,
        json!({
            "id":"legacy-fixture","agent_name":"Fixture","owner_name":"Owner",
            "persona":"Distinct persona","data_dir":existing,
        })
        .to_string(),
    )
    .unwrap();
    let directory = directory(&fixture);
    for instance in [Some(&existing_instance), None] {
        let (output, _) = fixture.run(
            "200 OK",
            json!({"data":{
                "employees":[{"sessionId":"session-123","name":"Fixture"}]
            }}),
            |command| {
                configure(&fixture, command);
                command
                    .env("REVERIE_DATA_DIR", &existing)
                    .env("REVERIE_ROOT", &fixture.0)
                    .env("REVERIE_MODEL", "original-model")
                    .env("REVERIE_API_BASE", "http://original-model.test/v1")
                    .env_remove("REVERIE_HANDS_API_KEY")
                    .env_remove("REVERIE_INSTANCE_CONFIG")
                    .args([
                        "--hands-launch",
                        "--native-runtime",
                        "echo",
                        "--chat-continuity",
                    ])
                    .arg(&database)
                    .arg("--no-tui");
                if let Some(path) = instance {
                    command.env("REVERIE_INSTANCE_CONFIG", path);
                    command.env("REVERIE_HANDS_API_KEY", "synthetic");
                }
            },
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let config_path = existing.join("hands/session-123/chat-continuity.json");
        let config: Value = serde_json::from_slice(&fs::read(config_path).unwrap()).unwrap();
        assert_eq!(config["model"], "original-model");
        assert_eq!(config["api_base"], "http://original-model.test/v1");
        assert_eq!(config["self_session_id"], "session-123");
        assert_eq!(
            config["model_key_env"],
            instance
                .map(|_| json!("REVERIE_HANDS_API_KEY"))
                .unwrap_or_default(),
        );
        let selection = Path::new(config["memory_instance"].as_str().unwrap());
        if let Some(instance) = instance {
            assert_eq!(selection, instance);
        }
        let loaded = reverie_host::memory_instance::LoadedMemoryInstance::load(selection).unwrap();
        assert_eq!(loaded.native_data_directory().unwrap(), existing);
    }
    assert!(!directory.join("memory-state").exists());
}
