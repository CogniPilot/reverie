use super::*;
use std::os::unix::fs::DirBuilderExt;

pub(super) fn prepare_control_directory(policy: &WorkerPoolPolicy) -> Result<()> {
    let home = native::python_path(&native::home_directory(None)?)?;
    need(
        home.join("reverie") == std::path::Path::new(&policy.instance_root),
        "WORKER_POOL_INSTANCE_ROOT_CHANGED",
    )?;
    let parent = std::path::Path::new(&policy.instance_root).join("worker-pool");
    let opened = native::open_at(
        libc::AT_FDCWD,
        parent.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    let result = (|| {
        let m = opened.metadata()?;
        need(
            m.uid() == policy.broker_uid
                && m.gid() == policy.broker_gid
                && m.mode() & 0o7777 == 0o700,
            "WORKER_POOL_CONTROL_PARENT",
        )?;
        let name =
            std::path::PathBuf::from(format!("/proc/self/fd/{}/control", opened.as_raw_fd()));
        let created = match std::fs::DirBuilder::new().mode(0o700).create(&name) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(error) => return Err(error.into()),
        };
        let directory = native::open_at(
            opened.as_raw_fd(),
            std::ffi::OsStr::new("control"),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        let body = (|| {
            let m = directory.metadata()?;
            need(
                m.uid() == policy.broker_uid && m.gid() == policy.broker_gid,
                "WORKER_POOL_CONTROL_DIRECTORY",
            )?;
            if created {
                need(m.mode() & 0o7777 == 0o700, "WORKER_POOL_CONTROL_DIRECTORY")?;
                nix::sys::stat::fchmod(&directory, nix::sys::stat::Mode::from_bits_truncate(0o770))
                    .map_err(std::io::Error::from)?;
                directory.sync_all()?;
                opened.sync_all()?;
            }
            need(
                directory.metadata()?.mode() & 0o7777 == 0o770,
                "WORKER_POOL_CONTROL_DIRECTORY",
            )
        })();
        finalized(body, native::close(directory).map_err(Into::into))
    })();
    finalized(result, native::close(opened).map_err(Into::into))
}
fn mount(source: &str, target: &str, readonly: bool) -> OsString {
    let source = format!("source={source}").replace('"', "\"\"");
    format!(
        "type=bind,\"{source}\",target={target}{}",
        if readonly { ",readonly" } else { "" }
    )
    .into()
}
pub(super) fn controller_arguments(
    policy: &WorkerPoolPolicy,
    digest: [u8; 32],
) -> Result<Vec<OsString>> {
    policy
        .validate()
        .map_err(|_| PoolError::Refused("WORKER_POOL_POLICY"))?;
    let digest = hex(digest);
    let mut args: Vec<OsString> = [
        "create",
        "--pull",
        "never",
        "--name",
        &policy.controller_name(),
        "--user",
        &format!("0:{}", policy.broker_gid),
        "--pid",
        "host",
        "--userns",
        "host",
        "--cgroupns",
        "host",
        "--cgroup-parent",
        "system.slice",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--memory",
        "268435456",
        "--memory-swap",
        "268435456",
        "--pids-limit",
        "128",
        "--cpuset-cpus",
        &policy.cpu_list(),
        "--restart",
        "no",
        "--env",
        "PATH=/bin",
        "--env",
        "LANG=C.UTF-8",
        "--label",
        &format!("reverie.resource-controller={}", policy.deployment),
        "--label",
        &format!(
            "reverie.pool.purpose={}",
            reverie_contracts::worker_pool::CONTROLLER_SERVICE_V2_PURPOSE
        ),
        "--label",
        &format!("reverie.pool.birth-policy={digest}"),
        "--entrypoint",
        "/bin/reverie-worker-resource-controller",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    for (source, target, readonly) in [
        (
            format!("{}/worker-pool/policies", policy.instance_root),
            "/run/reverie-worker-pool/policies",
            true,
        ),
        ("/proc".into(), "/run/reverie-host-proc", true),
        ("/sys/fs/cgroup".into(), "/sys/fs/cgroup", false),
        (
            "/var/run/docker.sock".into(),
            "/run/reverie-engine.sock",
            true,
        ),
        (
            format!("{}/worker-pool/control", policy.instance_root),
            "/run/reverie-worker-pool/control",
            false,
        ),
    ] {
        args.push("--mount".into());
        args.push(mount(&source, target, readonly));
    }
    args.extend(
        [
            policy.controller_image.clone(),
            "serve".into(),
            "--confinement-version".into(),
            "2".into(),
            "--birth-sha256".into(),
            digest,
        ]
        .into_iter()
        .map(Into::into),
    );
    Ok(args)
}
