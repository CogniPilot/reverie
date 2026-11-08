//! The launcher against a recording runner: no GPU, Docker, Nix or systemd is touched.
use reverie_local_model::{
    Capture, Error, Host, Runner, SamplingProfile, Usage, args, container_control, gpu_capability,
    main_with, prepare_socket, private_key, unit_quote,
};
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!("local-model-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

type Env = Vec<(String, String)>;

/// Answers each command with `stdout`, and records commands and the final exec.
#[derive(Default)]
struct Recorder {
    stdout: String,
    runs: Vec<(Vec<String>, Capture, Env)>,
    exec: Option<(PathBuf, Vec<String>, Env)>,
}

impl Runner for Recorder {
    fn run(
        &mut self,
        argv: &[String],
        capture: Capture,
        env: &[(String, String)],
    ) -> Result<String, Error> {
        self.runs.push((argv.to_vec(), capture, env.to_vec()));
        Ok(self.stdout.clone())
    }

    fn exec(&mut self, program: &Path, args: &[String], env: &[(String, String)]) -> Error {
        self.exec = Some((program.to_owned(), args.to_vec(), env.to_vec()));
        Error("exec recorded".into())
    }
}

fn after<'a>(args: &'a [String], flag: &str) -> &'a str {
    &args[args
        .iter()
        .position(|arg| arg == flag)
        .unwrap_or_else(|| panic!("{flag} in {args:?}"))
        + 1]
}

fn words(list: &[&str]) -> Vec<OsString> {
    list.iter().map(OsString::from).collect()
}

fn host(root: &Path, selected: Option<&Path>) -> Host {
    let mut env = vec![
        (
            "REVERIE_MODEL_SCRATCH".to_owned(),
            root.join("scratch").to_string_lossy().into_owned(),
        ),
        (
            "REVERIE_MODEL_BUILD_EXPR".to_owned(),
            "/fixture/build.nix".to_owned(),
        ),
        (
            "REVERIE_MODEL_NIXPKGS".to_owned(),
            "/fixture/nixpkgs".to_owned(),
        ),
        ("REVERIE_MODEL_SYSTEM".to_owned(), "x86_64-linux".to_owned()),
        (
            "REVERIE_MODEL_LAUNCHER".to_owned(),
            "/fixture/launcher".to_owned(),
        ),
    ];
    env.push((
        "REVERIE_ROOT".to_owned(),
        selected
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
    ));
    Host {
        home: root.to_owned(),
        env,
        driver: root.join("no-driver"),
    }
}

#[test]
fn vision_projector_and_image_budget_reach_server_and_saved_service_config() {
    let scratch = Scratch::new("vision");
    let root = &scratch.0;
    let model = root.join("model.gguf");
    let projector = root.join("mmproj.gguf");
    fs::write(&model, "").unwrap();
    fs::write(&projector, "").unwrap();
    for service in [false, true] {
        for selected in [None, Some(root.join("selected"))] {
            let host = host(root, selected.as_deref());
            let mut runner = Recorder {
                stdout: "/fixture/runtime\n".into(),
                ..Recorder::default()
            };
            let mut argv = vec![
                "--model",
                model.to_str().unwrap(),
                "--mmproj",
                projector.to_str().unwrap(),
            ];
            argv.extend([
                "--image-max-tokens",
                "2048",
                "--gpu",
                "cpu",
                "--context",
                "32768",
            ]);
            argv.extend(["--sampling-profile", "qwen3.8-thinking"]);
            if service {
                argv.push("--install-service");
            }
            let result = main_with(&mut runner, &host, &words(&argv));
            let state = selected
                .clone()
                .unwrap_or_else(|| root.join("reverie"))
                .join("runtime/local-model");
            let (build, capture, env) = &runner.runs[0];
            assert_eq!(build[..2], ["nix", "build"]);
            assert_eq!(
                after(build, "--out-link"),
                state.join("runtime").to_str().unwrap()
            );
            assert_eq!(after(build, "capability"), "");
            assert_eq!(*capture, Capture::Stdout);
            assert!(
                env.iter()
                    .any(|(key, value)| key == "NIX_BUILD_CORES" && value == "4")
            );
            assert!(!env.iter().any(|(key, _)| key == "CUDA_VISIBLE_DEVICES"));
            assert!(state.join("control/models/api-key").is_file());
            assert!(!root.join(".local").exists());
            if service {
                assert!(result.is_ok(), "{result:?}");
                assert!(runner.exec.is_none());
                let saved =
                    fs::read_to_string(root.join(".config/reverie/local-model.json")).unwrap();
                let config: serde_json::Value = serde_json::from_str(&saved).unwrap();
                assert_eq!(config["mmproj"], projector.to_str().unwrap());
                assert_eq!(config["image-max-tokens"], 2048);
                assert_eq!(config["sampling-profile"], "qwen3.8-thinking");
                let unit = fs::read_to_string(
                    root.join(".config/systemd/user/reverie-local-model.service"),
                )
                .unwrap();
                let config_path = root.join(".config/reverie/local-model.json");
                assert!(unit.contains(&format!(
                    "ExecStart=\"/fixture/launcher\" --config \"{}\"\n",
                    config_path.display()
                )));
                let commands: Vec<String> = runner.runs[1..]
                    .iter()
                    .map(|(argv, _, _)| argv.join(" "))
                    .collect();
                assert_eq!(
                    commands,
                    [
                        "systemctl --user daemon-reload",
                        "systemctl --user enable --now reverie-local-model.service"
                    ]
                );
                // The saved configuration reproduces the same launch.
                let again = args::from_config(&config_path).unwrap();
                assert_eq!(again.mmproj.as_deref(), projector.to_str());
                assert_eq!(again.sampling_profile, SamplingProfile::Qwen38Thinking);
                assert!(!again.install_service);
            } else {
                assert!(matches!(&result, Err(Usage::Failed(error)) if error.0 == "exec recorded"));
                let (program, args, _) = runner.exec.as_ref().unwrap();
                assert_eq!(program, Path::new("/fixture/runtime/bin/llama-server"));
                assert_eq!(after(args, "--mmproj"), projector.to_str().unwrap());
                assert_eq!(after(args, "--image-max-tokens"), "2048");
                assert_eq!(after(args, "--ctx-size"), "32768");
                assert_eq!(after(args, "--temp"), "1.0");
                assert_eq!(after(args, "--host"), "127.0.0.1");
                assert_eq!(after(args, "--gpu-layers"), "0");
            }
        }
    }
}

#[test]
fn restart_removes_only_an_abandoned_private_socket() {
    let scratch = Scratch::new("socket");
    let path = scratch.0.join("model.sock");
    prepare_socket(&path).unwrap();
    {
        let _listener = UnixListener::bind(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            prepare_socket(&path)
                .unwrap_err()
                .0
                .contains("already has a listener")
        );
        assert!(path.exists());
    }
    prepare_socket(&path).unwrap();
    assert!(!path.exists());
    fs::write(&path, "preserve me").unwrap();
    assert!(prepare_socket(&path).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "preserve me");
}

#[test]
fn selects_actual_gpu_architecture_instead_of_assuming_a_3090() {
    for capability in ["8.6", "8.9", "12.0"] {
        let mut runner = Recorder {
            stdout: format!("0, 7.5\n1, {capability}\n"),
            ..Recorder::default()
        };
        assert_eq!(gpu_capability(&mut runner, "1").unwrap(), capability);
        assert_eq!(runner.runs[0].1, Capture::All);
    }
    let mut runner = Recorder::default();
    assert_eq!(gpu_capability(&mut runner, "cpu").unwrap(), "");
    assert!(runner.runs.is_empty());
    for invalid in ["-1", "0;anything", "all", ""] {
        assert!(gpu_capability(&mut runner, invalid).is_err(), "{invalid}");
    }
    assert!(runner.runs.is_empty());
    let mut runner = Recorder {
        stdout: "0, N/A\n".into(),
        ..Recorder::default()
    };
    assert!(gpu_capability(&mut runner, "0").is_err());
}

#[test]
fn reuses_private_key_and_refuses_symlink_or_public_permissions() {
    let scratch = Scratch::new("key");
    let path = scratch.0.join("models/key");
    private_key(&path).unwrap();
    let value = fs::read(&path).unwrap();
    assert_eq!(value.len(), 65);
    private_key(&path).unwrap();
    assert_eq!(fs::read(&path).unwrap(), value);
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(private_key(&path).is_err());
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(scratch.0.join("target"), &path).unwrap();
    assert!(private_key(&path).is_err());
    assert!(!scratch.0.join("target").exists());
}

#[test]
fn container_binding_uses_only_the_existing_owner_control_mount() {
    let row = |rw: bool| serde_json::json!([{"Mounts": [{"Type": "bind", "RW": rw, "Destination": "/run/reverie-control", "Source": "/synthetic/control"}]}]);
    let mut runner = Recorder {
        stdout: row(true).to_string(),
        ..Recorder::default()
    };
    assert_eq!(
        container_control(&mut runner, "reverie").unwrap(),
        PathBuf::from("/synthetic/control")
    );
    assert_eq!(runner.runs[0].0, ["docker", "inspect", "reverie"]);
    let mut runner = Recorder {
        stdout: row(false).to_string(),
        ..Recorder::default()
    };
    assert!(container_control(&mut runner, "reverie").is_err());
    let mut runner = Recorder::default();
    assert!(container_control(&mut runner, "unsafe;name").is_err());
    assert!(runner.runs.is_empty());
}

#[test]
fn command_line_matches_the_documented_options() {
    let parsed = args::parse(&words(&[
        "--model=/m.gguf",
        "--port",
        "9000",
        "--gpu",
        "-1",
        "--port",
        "9001",
    ]))
    .unwrap();
    assert_eq!(parsed.model.as_deref(), Some("/m.gguf"));
    assert_eq!(
        (parsed.port, parsed.gpu.as_str(), parsed.context),
        (9001, "-1", 32768)
    );
    for bad in [
        &["--context", "big"][..],
        &["--sampling-profile", "other"],
        &["--unknown", "x"],
        &["stray"],
        &["--alias"],
    ] {
        assert!(
            matches!(args::parse(&words(bad)), Err(Usage::Invalid(_))),
            "{bad:?}"
        );
    }
    assert!(matches!(
        args::parse(&words(&["--help"])),
        Err(Usage::Help(_))
    ));
    let scratch = Scratch::new("args");
    let host = host(&scratch.0, None);
    let missing = main_with(&mut Recorder::default(), &host, &[]);
    assert!(matches!(missing, Err(Usage::Invalid(message)) if message == "--model is required"));
    let config = scratch.0.join("config.json");
    fs::write(&config, r#"{"model": "/m.gguf", "install-service": true}"#).unwrap();
    assert!(args::from_config(&config).is_err());
    fs::write(
        &config,
        r#"{"model": "/m.gguf", "context": 4096, "port": 9000}"#,
    )
    .unwrap();
    let saved = args::from_config(&config).unwrap();
    assert_eq!(
        (saved.context, saved.port, saved.alias.as_str()),
        (4096, 9000, "local-model")
    );
}

#[test]
fn unit_words_escape_specifiers_and_refuse_line_breaks() {
    assert_eq!(
        unit_quote(r#"/a b/%h$x"q\"#).unwrap(),
        r#""/a b/%%h$$x\"q\\""#
    );
    assert!(unit_quote("/a\nb").is_err());
}
