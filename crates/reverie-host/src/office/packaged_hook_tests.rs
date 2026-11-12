//! Explicit guest/Office component canary. This does not admit a broker job.
use super::*;
#[path = "packaged_hook_tests/process.rs"]
mod process;
use crate::engine_metadata::EngineBootstrap;
use reverie_contracts::{
    worker_child::encode_launch_record, worker_config, worker_launch::WorkerRequest,
};
use reverie_core::{
    ids::ProfileSessionId,
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    worker_schema::{WorkerBase, WorkerIds},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    image: String,
    docker: PathBuf,
    upstream: SocketAddr,
    company: PathBuf,
    workspace: PathBuf,
    provider: PathBuf,
    request: PathBuf,
    result: PathBuf,
}
struct Container {
    docker: PathBuf,
    cid: String,
    cleanup_attempted: bool,
}
impl Container {
    fn finish(&mut self) {
        self.cleanup_attempted = true;
        success(Command::new(&self.docker).args(["rm", "--force", &self.cid]));
    }
}
impl Drop for Container {
    fn drop(&mut self) {
        if self.cleanup_attempted {
            return;
        }
        // Best effort during unwinding. The parent also verifies exact owned
        // CID-file labels and absence before removing its private fixture root.
        let _ = process::bounded(
            Command::new(&self.docker).args(["rm", "--force", &self.cid]),
            Duration::from_secs(3),
            128 * 1024,
        );
    }
}
fn run(command: &mut Command) -> std::process::Output {
    process::bounded(command, Duration::from_secs(20), 128 * 1024).unwrap()
}
fn success(command: &mut Command) -> Vec<u8> {
    let output = run(command);
    assert!(
        output.status.success(),
        "owned hook fixture command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}
fn private_write(path: &Path, bytes: &[u8]) {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(bytes).unwrap();
    file.sync_all().unwrap();
}
fn contained(root: &Path, path: &Path) {
    assert!(
        fs::canonicalize(path).unwrap().starts_with(root),
        "fixture path escaped its owned root"
    );
}

fn owned_input() -> (PathBuf, Input) {
    assert_eq!(
        std::env::var("REVERIE_NATIVE_HOOK_FIXTURE").as_deref(),
        Ok("1")
    );
    let root = fs::canonicalize(std::env::var_os("REVERIE_NATIVE_HOOK_ROOT").unwrap()).unwrap();
    let info = fs::symlink_metadata(&root).unwrap();
    assert!(info.is_dir() && info.uid() == crate::native::uid() && info.mode() & 0o077 == 0);
    assert!(
        root.file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("rnh-")
    );
    assert_eq!(
        fs::read(root.join(".native-hook-fixture")).unwrap(),
        b"native-worker-hook-component-v1\n"
    );
    let input_path = PathBuf::from(std::env::var_os("REVERIE_NATIVE_HOOK_INPUT").unwrap());
    contained(&root, &input_path);
    let input: Input = serde_json::from_slice(&fs::read(input_path).unwrap()).unwrap();
    assert!(input.upstream.ip().is_loopback() && input.upstream.port() != 0);
    assert!(input.image.strip_prefix("sha256:").is_some_and(
        |value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    ));
    assert!(input.docker.is_absolute() && fs::metadata(&input.docker).unwrap().is_file());
    for path in [
        &input.company,
        &input.workspace,
        &input.provider,
        &input.request,
    ] {
        contained(&root, path);
    }
    contained(&root, input.result.parent().unwrap());
    assert!(!input.result.exists());
    (root, input)
}
fn prepare_request(input: &Input) -> (WorkerRequest, PathBuf) {
    let config = worker_config::decode(&serde_json::to_vec(&serde_json::json!({"mounts":[{"source":input.workspace,"destination":input.workspace,"readOnly":false}]})).unwrap()).unwrap();
    let request = WorkerRequest::decode(&fs::read(&input.request).unwrap(), &config).unwrap();
    assert_eq!(
        crate::native::python_path(request.directory().codepoints()).unwrap(),
        input.workspace
    );
    let case = input.result.parent().unwrap();
    let launch = case.join("launch");
    fs::create_dir(&launch).unwrap();
    fs::set_permissions(&launch, fs::Permissions::from_mode(0o700)).unwrap();
    private_write(
        &launch.join("component.json"),
        &encode_launch_record(&request),
    );
    (request, launch)
}
fn worker_runtime(root: &Path, input: &Input, deployment: &str) -> WorkerRuntime {
    let base = WorkerBase::try_new(
        deployment.to_owned(),
        deployment.to_owned(),
        input.image.clone(),
        WorkerIds::try_new(crate::native::uid(), nix::unistd::getgid().as_raw()).unwrap(),
        4,
        ResourcePolicy::try_new(
            BudgetMode::Admission,
            1024,
            128,
            CpuQuota::from_integer(1).unwrap(),
            8192,
            512,
        )
        .unwrap(),
    )
    .unwrap();
    let environment = std::env::var_os("DOCKER_HOST")
        .map(|value| BTreeMap::from([("DOCKER_HOST".into(), value)]))
        .unwrap_or_default();
    assert!(
        std::env::var("DOCKER_HOST")
            .ok()
            .is_none_or(|value| value.starts_with("unix:///"))
    );
    WorkerRuntime::new(
        InstalledWorkerEngine::new(
            EngineBootstrap::from_service(input.docker.as_os_str(), environment, root.to_owned())
                .unwrap(),
        ),
        &base,
    )
}
#[test]
#[ignore = "explicit immutable Docker guest and real owned HTTP server; run the TypeScript acceptance CLI"]
fn entry() {
    let (root, input) = owned_input();
    let (request, launch) = prepare_request(&input);
    let case = input.result.parent().unwrap();
    let deployment = format!(
        "hook-fixture-{}",
        &crate::resource_facts::fresh_owner_nonce().unwrap().as_str()[..12]
    );
    let runtime = worker_runtime(&root, &input, &deployment);
    let service =
        OfficeService::from_runtime(&runtime, input.company.clone(), input.upstream.ip()).unwrap();
    service
        .company
        .address
        .update_fixed(input.upstream)
        .unwrap();
    let phone = service
        .bind(
            case.join("office"),
            ProfileSessionId::parse(request.session().as_str()).unwrap(),
        )
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        exercise(&input, &launch, case, &deployment)
    }));
    service
        .close_phone(&phone, Instant::now() + Duration::from_secs(3))
        .unwrap();
    service
        .close(Instant::now() + Duration::from_secs(3))
        .unwrap();
    runtime
        .close(Instant::now() + Duration::from_secs(3))
        .unwrap();
    if let Err(cause) = result {
        std::panic::resume_unwind(cause);
    }
}

fn create_container(input: &Input, launch: &Path, case: &Path, name: &str) -> Container {
    let uid = format!(
        "{}:{}",
        crate::native::uid(),
        nix::unistd::getgid().as_raw()
    );
    assert!(crate::native::uid() > 0);
    let mount = |source: &Path, target: &Path, readonly: bool| {
        format!(
            "type=bind,src={},dst={}{}",
            source.display(),
            target.display(),
            if readonly { ",readonly" } else { "" }
        )
    };
    let cidfile = case.join("cid");
    let create = run(Command::new(&input.docker)
        .args(["create", "--cidfile"])
        .arg(&cidfile)
        .args([
            "--name",
            name,
            "--label",
            "reverie.fixture=native-hook-component-v1",
            "--label",
            &format!(
                "reverie.fixture.owner={}",
                case.parent()
                    .unwrap()
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
            ),
            "--network",
            "none",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "128",
            "--memory",
            "512m",
            "--user",
            &uid,
            "--mount",
        ])
        .arg(mount(&input.workspace, &input.workspace, false))
        .arg("--mount")
        .arg(mount(
            &input.provider,
            Path::new("/home/agent/.local/bin"),
            true,
        ))
        .arg("--mount")
        .arg(mount(
            &input.provider,
            Path::new("/opt/reverie/autoenv/bin"),
            true,
        ))
        .arg("--mount")
        .arg(mount(&input.provider, &input.provider, true))
        .arg("--mount")
        .arg(mount(
            launch,
            Path::new("/home/agent/.reverie-launch"),
            false,
        ))
        .arg("--mount")
        .arg(mount(
            &case.join("office"),
            Path::new("/run/reverie-office"),
            true,
        ))
        .args(["--entrypoint", "/bin/sleep", &input.image, "infinity"]));
    let cid = fs::read_to_string(&cidfile).unwrap().trim().to_owned();
    assert!(cid.len() == 64 && cid.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let container = Container {
        docker: input.docker.clone(),
        cid,
        cleanup_attempted: false,
    };
    assert!(create.status.success(), "owned container create failed");
    container
}
fn guest_manifest(input: &Input, case: &Path, container: &Container) -> serde_json::Value {
    for (guest, name) in [
        ("/bin/reverie-worker-child", "child"),
        ("/opt/reverie/worker-child/program.json", "manifest.json"),
    ] {
        success(
            Command::new(&input.docker)
                .args(["cp", "-L", &format!("{}:{guest}", container.cid)])
                .arg(case.join(name)),
        );
    }
    let child = fs::read(case.join("child")).unwrap();
    assert!(child.starts_with(b"\x7fELF"));
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(case.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["purpose"], "worker-child-program-v1");
    assert_eq!(manifest["abi"], "record-pane-exit-v1");
    assert_eq!(
        manifest["program"]["sha256"],
        format!("{:x}", Sha256::digest(&child))
    );
    assert_eq!(manifest["program"]["bytes"], child.len());
    let packaged = PathBuf::from(manifest["program"]["path"].as_str().unwrap());
    assert!(packaged.starts_with("/nix/store"));
    assert!(
        fs::read(packaged).unwrap() == child,
        "guest helper differs from the immutable declared package"
    );
    manifest
}
fn exercise(input: &Input, launch: &Path, case: &Path, name: &str) {
    let mut container = create_container(input, launch, case, name);
    let manifest = guest_manifest(input, case, &container);
    success(Command::new(&input.docker).args(["start", &container.cid]));
    let selected = success(Command::new(&input.docker).args(["exec", &container.cid, "/bin/node", "-e",
        "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/opt/reverie/autoenv/bin/claude')).digest('hex'))"]));
    assert_eq!(
        String::from_utf8(selected).unwrap(),
        format!(
            "{:x}",
            Sha256::digest(fs::read(input.provider.join("claude")).unwrap())
        ),
        "guest stand-in preflight failed"
    );
    let output = success(Command::new(&input.docker).args([
        "exec",
        &container.cid,
        "/bin/reverie-worker-child",
        "/home/agent/.reverie-launch/component.json",
    ]));
    let proof = serde_json::json!({"scope":"actual guest child/settings/Office/HTTP component; no broker job admission", "image":input.image, "child":manifest, "providerOutput":String::from_utf8(output).unwrap()});
    private_write(&input.result, &serde_json::to_vec(&proof).unwrap());
    container.finish();
}
