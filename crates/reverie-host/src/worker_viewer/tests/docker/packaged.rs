//! Actual CI-built viewer image; no host viewer binary or production mounts.
use super::*;
use std::os::unix::fs::FileTypeExt;

const SERVICE_IMAGE: &str = "REVERIE_VIEWER_TEST_SERVICE_IMAGE";
const CASE: &str = "worker_viewer::tests::docker::packaged::packaged_viewer_profile_preserves_provider_through_disconnect_and_sigterm";

#[test]
#[ignore = "explicit CI-built immutable worker and viewer images; no downloads"]
fn packaged_viewer_profile_preserves_provider_through_disconnect_and_sigterm() {
    assert_eq!(
        std::env::var("REVERIE_VIEWER_DOCKER_FIXTURE").as_deref(),
        Ok("1")
    );
    if std::env::var("REVERIE_VIEWER_PACKAGED_CHILD").as_deref() != Ok("1") {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                CASE,
                "--test-threads=1",
                "--nocapture",
            ])
            .env("REVERIE_VIEWER_PACKAGED_CHILD", "1")
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
    exercise_packaged();
}

fn local_engine_socket() -> PathBuf {
    let selected =
        std::env::var("DOCKER_HOST").unwrap_or_else(|_| "unix:///var/run/docker.sock".into());
    let path = PathBuf::from(
        selected
            .strip_prefix("unix://")
            .expect("packaged canary requires a local Unix engine"),
    );
    assert!(path.is_absolute());
    assert!(fs::symlink_metadata(&path).unwrap().file_type().is_socket());
    fs::canonicalize(path).unwrap()
}

fn create_sidecar(fixture: &Fixture, docker: &Path, source: &Path, socket: &Path) -> Container {
    let image = immutable_image(docker, SERVICE_IMAGE);
    let details = Command::new(docker)
        .args(["image", "inspect", &image])
        .output()
        .unwrap();
    assert!(details.status.success());
    let rows: serde_json::Value = serde_json::from_slice(&details.stdout).unwrap();
    assert_eq!(
        rows[0]["Config"]["Labels"]["reverie.purpose"],
        "reverie-worker-viewer-v1"
    );
    let entry = rows[0]["Config"]["Entrypoint"].as_array().unwrap();
    assert_eq!(entry.len(), 2);
    assert!(entry[0].as_str().unwrap().starts_with("/nix/store/"));
    assert!(
        entry[0]
            .as_str()
            .unwrap()
            .ends_with("/bin/reverie-worker-broker")
    );
    assert_eq!(entry[1], "viewer-only");
    let engine = local_engine_socket();
    let group = fs::metadata(&engine).unwrap().gid().to_string();
    let user = format!(
        "{}:{}",
        crate::native::uid(),
        nix::unistd::getgid().as_raw()
    );
    let name = format!(
        "viewer-profile-{}",
        &crate::resource_facts::fresh_owner_nonce().unwrap().as_str()[..12]
    );
    let output = Command::new(docker)
        .args([
            "create",
            "--name",
            &name,
            "--network",
            "none",
            "--read-only",
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
            "--group-add",
            &group,
            "--mount",
            &format!(
                "type=bind,src={},dst={}",
                fixture.root.display(),
                fixture.root.display()
            ),
            "--mount",
            &format!(
                "type=bind,src={},dst=/var/run/docker.sock",
                engine.display()
            ),
            &image,
            "--config",
            source.to_str().unwrap(),
            "--socket",
            socket.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "disposable packaged viewer: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let id = String::from_utf8(output.stdout).unwrap().trim().to_owned();
    assert!(id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let container = Container {
        docker: docker.to_owned(),
        id,
    };
    container.output(&["start", &container.id]);
    container
}

fn attach(fixture: &Fixture, worker: &Container, socket: &Path) -> UnixStream {
    let mut client = UnixStream::connect(socket).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    broker_listener::write_frame(&mut client, b'J', &fixture.raw(true, SID)).unwrap();
    broker_listener::write_frame(&mut client, b'I', "PACKAGED › ──\n".as_bytes()).unwrap();
    until(&mut client, "PACKAGED › ──".as_bytes());
    broker_listener::write_frame(&mut client, b'R', b"[101,31]").unwrap();
    let end = Instant::now() + Duration::from_secs(5);
    while worker.tmux(&[
        "display-message",
        "-p",
        "-t",
        "office",
        "#{pane_width} #{pane_height}",
    ]) != b"101 31\n"
    {
        assert!(
            Instant::now() < end,
            "packaged native viewer must resize real worker tmux"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    client
}

fn exercise_packaged() {
    let fixture = Fixture::new();
    let (worker, deployment) = create_container(&fixture);
    let source = configuration(&fixture, deployment);
    let socket = fixture.root.join("packaged-viewer.sock");
    let original_pane = worker.pane();
    assert!(original_pane.ends_with(":0"));
    let original_start =
        worker.output(&["inspect", "--format", "{{.State.StartedAt}}", &worker.id]);
    let sidecar = create_sidecar(&fixture, &worker.docker, &source, &socket);
    let end = Instant::now() + Duration::from_secs(15);
    while !socket.exists() {
        assert!(
            Instant::now() < end,
            "packaged viewer failed to create its selected socket"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let metadata = fs::metadata(&socket).unwrap();
    assert_eq!(metadata.uid(), crate::native::uid());
    assert_eq!(metadata.mode() & 0o7777, 0o600);
    drop(attach(&fixture, &worker, &socket));
    assert_eq!(
        worker.pane(),
        original_pane,
        "disconnect must preserve the exact stdin-reading model"
    );
    let client = attach(&fixture, &worker, &socket);
    // Keep the connection open so ordinary peer close cannot mask shutdown.
    sidecar.output(&["kill", "--signal", "TERM", &sidecar.id]);
    let end = Instant::now() + Duration::from_secs(20);
    while sidecar.output(&["inspect", "--format", "{{.State.Running}}", &sidecar.id]) != b"false\n"
    {
        assert!(
            Instant::now() < end,
            "packaged viewer must settle its own clients on SIGTERM"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        sidecar.output(&["inspect", "--format", "{{.State.ExitCode}}", &sidecar.id]),
        b"0\n"
    );
    drop(client);
    assert_eq!(
        worker.pane(),
        original_pane,
        "packaged service SIGTERM must preserve exact model PID"
    );
    assert_eq!(
        worker.output(&["inspect", "--format", "{{.State.StartedAt}}", &worker.id]),
        original_start
    );
    assert!(
        !socket.exists(),
        "packaged graceful shutdown must release its own socket"
    );
}
