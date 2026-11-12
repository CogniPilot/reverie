//! Explicitly opted-in daemon fixture. No production mounts, names or sessions.
use super::*;
use std::{ffi::OsString, os::unix::fs::MetadataExt};
mod packaged;
const WORKER_IMAGE: &str = "REVERIE_VIEWER_TEST_WORKER_IMAGE";
const CASE: &str = "worker_viewer::tests::docker::docker_tmux_disconnect_and_service_termination_preserve_exact_pane";

struct Container {
    docker: PathBuf,
    id: String,
}
impl Container {
    fn output(&self, args: &[&str]) -> Vec<u8> {
        let output = Command::new(&self.docker).args(args).output().unwrap();
        assert!(
            output.status.success(),
            "disposable Docker fixture: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }
    fn tmux(&self, args: &[&str]) -> Vec<u8> {
        let mut argv = vec!["exec", &self.id, "/bin/tmux", "-u", "-L", "reverie-laptop"];
        argv.extend_from_slice(args);
        self.output(&argv)
    }
    fn pane(&self) -> String {
        String::from_utf8(self.tmux(&[
            "display-message",
            "-p",
            "-t",
            "office",
            "#{pane_pid}:#{pane_dead}",
        ]))
        .unwrap()
        .trim()
        .into()
    }
}
impl Drop for Container {
    fn drop(&mut self) {
        // Only the exact canonical CID returned by our own successful create.
        let _ = Command::new(&self.docker)
            .args(["rm", "--force", &self.id])
            .output();
    }
}

#[test]
#[ignore = "explicit disposable Docker daemon fixture; no image downloads"]
fn docker_tmux_disconnect_and_service_termination_preserve_exact_pane() {
    assert_eq!(
        std::env::var("REVERIE_VIEWER_DOCKER_FIXTURE").as_deref(),
        Ok("1")
    );
    if std::env::var("REVERIE_VIEWER_DOCKER_CHILD").as_deref() != Ok("1") {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                CASE,
                "--test-threads=1",
                "--nocapture",
            ])
            .env("REVERIE_VIEWER_DOCKER_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    exercise();
}
fn create_container(fixture: &Fixture) -> (Container, String) {
    let docker = docker_path();
    let image = immutable_image(&docker, WORKER_IMAGE);
    let user = format!(
        "{}:{}",
        crate::native::uid(),
        nix::unistd::getgid().as_raw()
    );
    assert!(
        crate::native::uid() > 0,
        "run the canary as an ordinary engine user"
    );
    let passwd = fixture.root.join("passwd");
    fs::write(
        &passwd,
        format!(
            "worker:x:{}:{}:Synthetic worker:/tmp:/bin/sh\n",
            crate::native::uid(),
            nix::unistd::getgid().as_raw()
        ),
    )
    .unwrap();
    let deployment = format!(
        "viewer-canary-{}",
        &crate::resource_facts::fresh_owner_nonce().unwrap().as_str()[..12]
    );
    let name = format!("{deployment}-agent-{SID}");
    let output = Command::new(&docker)
        .args([
            "create",
            "--name",
            &name,
            "--network",
            "none",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "128",
            "--memory",
            "256m",
            "--user",
            &user,
            "--workdir",
            "/tmp",
            "--env",
            "HOME=/tmp",
            "--mount",
            &format!(
                "type=bind,src={},dst=/etc/passwd,readonly",
                passwd.display()
            ),
            "--label",
            &format!("reverie.worker={deployment}"),
            "--label",
            &format!("reverie.session={SID}"),
            "--label",
            "reverie.employee=11111111-2222-4333-8444-555555555555",
            "--entrypoint",
            "/bin/sleep",
            &image,
            "infinity",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "create disposable fixture: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let id = String::from_utf8(output.stdout).unwrap().trim().to_owned();
    assert!(id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let container = Container {
        docker: docker.clone(),
        id,
    };
    container.output(&["start", &container.id]);
    container.tmux(&[
        "new-session",
        "-d",
        "-x",
        "80",
        "-y",
        "24",
        "-s",
        "office",
        "/bin/cat",
    ]);
    container.tmux(&["set-option", "-t", "office", "status", "off"]);
    container.tmux(&["set-option", "-t", "office", "remain-on-exit", "on"]);
    (container, deployment)
}
fn service(
    fixture: &Fixture,
    container: &Container,
    deployment: String,
) -> Arc<WorkerViewerService> {
    let source = configuration(fixture, deployment);
    let mut environment =
        BTreeMap::<OsString, OsString>::from([("PATH".into(), std::env::var_os("PATH").unwrap())]);
    if let Some(host) = std::env::var_os("DOCKER_HOST") {
        environment.insert("DOCKER_HOST".into(), host);
    }
    WorkerViewerService::new(
        &source,
        EngineBootstrap::from_service(
            container.docker.as_os_str(),
            environment,
            fixture.root.clone(),
        )
        .unwrap(),
    )
    .unwrap()
}
fn configuration(fixture: &Fixture, deployment: String) -> PathBuf {
    let source = fixture.root.join("broker.json");
    let mut config: serde_json::Value =
        serde_json::from_slice(&fs::read(&source).unwrap()).unwrap();
    config["deployment"] = deployment.into();
    config["gid"] = nix::unistd::getgid().as_raw().into();
    fs::write(&source, serde_json::to_vec(&config).unwrap()).unwrap();
    source
}

fn docker_path() -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|path| path.join("docker"))
        .find(|path| path.is_file())
        .expect("fixed local Docker executable")
}
fn immutable_image_id(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}
fn immutable_image(docker: &Path, variable: &str) -> String {
    let selected =
        std::env::var(variable).expect("explicit immutable canary image environment is required");
    assert!(
        immutable_image_id(&selected),
        "canary images require canonical immutable IDs"
    );
    let output = Command::new(docker)
        .args(["image", "inspect", "--format", "{{.Id}}", &selected])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "required image must already be loaded; no pull attempted"
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        selected,
        "loaded image must match selected immutable ID"
    );
    selected
}
#[test]
fn immutable_image_input_rejects_mutable_and_malformed_names() {
    assert!(immutable_image_id(&format!("sha256:{}", "a".repeat(64))));
    for value in [
        "latest",
        "reverie/worker:current",
        "sha256:abc",
        "sha256:",
        "",
        "sha256:GG",
    ] {
        assert!(!immutable_image_id(value));
    }
    assert!(!immutable_image_id(&format!("sha256:{}\n", "a".repeat(64))));
    assert!(!immutable_image_id(&format!("sha256:{}", "A".repeat(64))));
}
fn exercise() {
    let fixture = Fixture::new();
    let (container, deployment) = create_container(&fixture);
    let service = service(&fixture, &container, deployment);
    let original_pane = container.pane();
    assert!(original_pane.ends_with(":0"));
    let started = container.output(&["inspect", "--format", "{{.State.StartedAt}}", &container.id]);
    let socket = fixture.root.join("viewer.sock");
    let runner = service.clone();
    let socket_run = socket.clone();
    let task = std::thread::spawn(move || runner.run(&socket_run));
    let end = Instant::now() + Duration::from_secs(10);
    while !socket.exists() {
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(fs::metadata(&socket).unwrap().uid(), crate::native::uid());
    let mut final_client = None;
    for pass in 0..2 {
        let mut client = UnixStream::connect(&socket).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        broker_listener::write_frame(&mut client, b'J', &fixture.raw(true, SID)).unwrap();
        broker_listener::write_frame(&mut client, b'I', "READY › ──\n".as_bytes()).unwrap();
        until(&mut client, "READY › ──".as_bytes());
        broker_listener::write_frame(&mut client, b'R', b"[101,31]").unwrap();
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            if container.tmux(&[
                "display-message",
                "-p",
                "-t",
                "office",
                "#{pane_width} #{pane_height}",
            ]) == b"101 31\n"
            {
                break;
            }
            assert!(Instant::now() < end, "real tmux resize not observed");
            std::thread::sleep(Duration::from_millis(10));
        }
        if pass == 0 {
            drop(client);
            let end = Instant::now() + Duration::from_secs(5);
            while service.active.load(Ordering::Acquire) != 0 {
                assert!(Instant::now() < end);
                std::thread::sleep(Duration::from_millis(10));
            }
        } else {
            // Signal only this isolated fixture process; no host service signal.
            nix::sys::signal::kill(nix::unistd::Pid::this(), nix::sys::signal::Signal::SIGTERM)
                .unwrap();
            final_client = Some(client);
        }
        assert_eq!(
            container.pane(),
            original_pane,
            "same stdin-reading tmux model must survive viewer disconnect {pass}"
        );
        assert_eq!(
            container.output(&["inspect", "--format", "{{.State.StartedAt}}", &container.id]),
            started
        );
    }
    task.join().unwrap().unwrap();
    drop(final_client);
    assert_eq!(
        container.pane(),
        original_pane,
        "service SIGTERM must preserve exact model PID"
    );
    assert!(service.retained.lock().unwrap().is_empty());
    assert!(!socket.exists());
}
