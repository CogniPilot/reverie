//! Synthetic compared metadata only selects our own process/owned child. These
//! controls do not attest an engine, website, image, peer program or owner.
use super::*;
use crate::native::owned_process as process;
use reverie_contracts::resource_actor::{
    CodeFile, EngineMetadata, ProgramSelection, WebsiteSelection,
};
use reverie_core::{PythonText, ids::ContainerId};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    io::{self, Write},
    os::fd::OwnedFd,
    os::unix::fs::MetadataExt,
    process::{Child, Command, Stdio},
    time::Duration,
};
const READY: &[u8] = b"WEBSITE_SNAPSHOT_CHILD_READY\n";
type TestResult<T> = std::result::Result<T, String>;
fn end() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
pub(crate) fn metadata(pid: u32) -> QualifiedWebsiteMetadata {
    let config = json!({"User":"1000:100","Env":[]});
    let host = json!({"OomKillDisable":false,"ReadonlyRootfs":true,"Privileged":false,
        "CapDrop":["ALL"],"CapAdd":null,"PidMode":"private","SecurityOpt":["no-new-privileges"]});
    let mounts = json!([]);
    let digest = |value: &serde_json::Value| {
        JournalDigest::parse(&format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(value).unwrap())
        ))
        .unwrap()
    };
    let program = || ProgramSelection {
        executable: PythonText::from_scalar_text("/nix/store/synthetic/bin/node"),
        argv: vec![PythonText::from_scalar_text(
            "/nix/store/synthetic/bin/node",
        )],
    };
    let selected = WebsiteSelection {
        container: ContainerId::parse(&"a".repeat(64)).unwrap(),
        image: format!("sha256:{}", "b".repeat(64)),
        config_digest: digest(&config),
        host_config_digest: digest(&host),
        mounts_digest: digest(&mounts),
        initial: None,
        uid: 1000,
        gid: 100,
        bootstrap: program(),
        node: program(),
        code: vec![CodeFile {
            path: PythonText::from_scalar_text("/nix/store/synthetic/bin/node"),
            sha256: JournalDigest::parse(&"c".repeat(64)).unwrap(),
            bytes: 1,
        }],
    };
    let value = json!({"Id":selected.container.as_str(),"Image":selected.image,"State":{"Running":true,"Pid":pid},
        "Config":config,"HostConfig":host,"Mounts":mounts});
    EngineMetadata::decode(&serde_json::to_vec(&value).unwrap())
        .unwrap()
        .qualify_website(&selected)
        .unwrap()
}
#[test]
fn actual_self_snapshot_matches_kernel_executable_namespaces_and_raw_cmdline_hash() {
    let mut observer = WebsiteProcessObserver::default();
    let snapshot = observer
        .observe_init(&metadata(std::process::id()), end())
        .unwrap();
    assert_eq!(snapshot.pid().to_u64(), Some(u64::from(std::process::id())));
    let executable = std::fs::metadata("/proc/self/exe").unwrap();
    assert_eq!(snapshot.executable(), [executable.dev(), executable.ino()]);
    let expected = ["mnt", "pid", "user"].map(|name| {
        std::fs::metadata(format!("/proc/self/ns/{name}"))
            .unwrap()
            .ino()
    });
    assert_eq!(snapshot.namespaces(), expected);
    let argv = std::fs::read("/proc/self/cmdline").unwrap();
    assert_eq!(
        snapshot.argv_digest().as_str(),
        format!("{:x}", Sha256::digest(argv))
    );
}
pub(super) fn finish(child: &mut Child) -> TestResult<std::process::ExitStatus> {
    let input = child
        .stdin
        .take()
        .map(|file| process::close(file.into()))
        .transpose();
    let status = reap(child);
    match (status, input) {
        (Ok(status), Ok(_)) => Ok(status),
        (status, input) => Err(format!(
            "owned child settlement: {status:?}; stdin: {input:?}"
        )),
    }
}
fn reap(child: &mut Child) -> TestResult<std::process::ExitStatus> {
    let mut deadline = end();
    let mut killed = false;
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            if killed {
                return Err("original child reap remains unknown after one kill".into());
            }
            killed = true;
            child.kill().map_err(|error| error.to_string())?;
            deadline = end();
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}
pub(super) fn child(ready: bool) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "website_facts::process::tests::snapshot_child",
        ])
        .env(
            "REVERIE_WEBSITE_SNAPSHOT_CHILD",
            if ready { "1" } else { "0" },
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}
pub(super) fn await_ready(output: &OwnedFd, deadline: Instant) -> TestResult<()> {
    process::nonblocking(output).map_err(|error| error.to_string())?;
    let mut raw = Vec::new();
    loop {
        let mut chunk = [0; 512];
        match process::read(output, &mut chunk) {
            Ok(0) => {
                return Err(format!(
                    "child EOF before Ready: {}",
                    String::from_utf8_lossy(&raw)
                ));
            }
            Ok(count) => {
                raw.extend_from_slice(&chunk[..count]);
                if raw.len() > 4096 {
                    return Err("owned child Ready output exceeded bound".into());
                }
                if raw.windows(READY.len()).any(|window| window == READY) {
                    return Ok(());
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error.to_string()),
        }
        if Instant::now() >= deadline {
            return Err("owned child Ready deadline".into());
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}
#[test]
fn actual_owned_child_snapshot_keeps_parent_and_inherited_namespace_data() {
    let mut child = child(true);
    let output: OwnedFd = child.stdout.take().expect("fixed piped stdout").into();
    let mut observer = WebsiteProcessObserver::default();
    // Exec completion is not user-main readiness. Observe once only after the
    // actual fixed child announces that it has reached its stdin wait.
    let body = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        await_ready(&output, end())?;
        observer
            .observe_init(&metadata(child.id()), end())
            .map_err(|error| error.to_string())
    }));
    let status = finish(&mut child);
    let closed = process::close(output);
    if status.is_err() {
        eprintln!("original child {} retained: {status:?}", child.id());
        std::mem::forget(child);
    }
    if closed.is_err() {
        eprintln!("original stdout consumed-close remains unconfirmed: {closed:?}");
    }
    let result = match body {
        Ok(result) => result,
        Err(primary) => std::panic::resume_unwind(primary),
    };
    let snapshot = result.unwrap();
    let status = status.unwrap();
    closed.unwrap();
    assert!(status.success());
    assert_eq!(
        snapshot.parent().to_u64(),
        Some(u64::from(std::process::id()))
    );
    let parent = observer
        .observe_init(&metadata(std::process::id()), end())
        .unwrap();
    assert_eq!(snapshot.namespaces(), parent.namespaces());
}
#[test]
fn actual_failed_snapshot_child_cannot_supply_ready_and_is_reaped_before_verdict() {
    let mut child = child(false);
    let output: OwnedFd = child.stdout.take().expect("fixed piped stdout").into();
    let ready = await_ready(&output, end());
    let status = finish(&mut child);
    let closed = process::close(output);
    if status.is_err() {
        eprintln!("original child {} retained: {status:?}", child.id());
        std::mem::forget(child);
    }
    assert!(ready.is_err(), "failed child must never announce Ready");
    assert!(!status.unwrap().success());
    closed.unwrap();
}
#[test]
fn actual_consumed_descriptor_close_failure_latches_observer_without_retry() {
    let mut observer = WebsiteProcessObserver::default();
    crate::native::test_faults::set(None, true);
    let first = observer.observe_init(&metadata(std::process::id()), end());
    crate::native::test_faults::set(None, false);
    let later = observer.observe_init(&metadata(std::process::id()), end());
    assert_eq!(
        first.err().unwrap().code(),
        "BACKEND_CODE_CLOSE_UNCONFIRMED"
    );
    assert_eq!(
        later.err().unwrap().code(),
        "WEBSITE_PROCESS_CLOSE_UNCONFIRMED"
    );
}
#[test]
#[ignore = "fixed owned native child, invoked only by its control"]
fn snapshot_child() {
    assert_eq!(
        std::env::var("REVERIE_WEBSITE_SNAPSHOT_CHILD").unwrap(),
        "1"
    );
    std::io::stdout().write_all(READY).unwrap();
    std::io::stdout().flush().unwrap();
    use std::io::Read;
    let mut byte = [0];
    let _ = std::io::stdin().read(&mut byte);
}
