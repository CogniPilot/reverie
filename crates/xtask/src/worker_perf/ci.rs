//! Explicit disposable CI prerequisite; NixOS hosts use worker-isolation.nix.
//! Environment is an accidental-use guard; ordinary sudo remains authority.
use super::*;
#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
pub(super) fn prepare() -> Result<()> {
    super::super::ci_userns::declared_runner(
        std::env::var("GITHUB_ACTIONS").ok().as_deref(),
        std::env::var("REVERIE_CI_RUNNER_ENVIRONMENT")
            .ok()
            .as_deref(),
        std::env::var("RUNNER_OS").ok().as_deref(),
        std::env::var("CI").ok().as_deref(),
    )?;
    super::super::ci_userns::ubuntu24(&fs::read_to_string("/etc/os-release")?)?;
    super::super::ci_userns::trusted_tool(Path::new("/usr/bin/sudo"))?;
    super::super::ci_userns::trusted_tool(Path::new("/usr/sbin/sysctl"))?;
    if !Path::new("/proc/sys/kernel/perf_event_paranoid").is_file() {
        return Err(
            "host kernel has no perf_event_open support; perf acceptance cannot run".into(),
        );
    }
    let status = Command::new("/usr/bin/sudo")
        .args([
            "--non-interactive",
            "--",
            "/usr/sbin/sysctl",
            "--write",
            "kernel.perf_event_paranoid=2",
        ])
        .status()?;
    if !status.success() {
        return Err(format!("disposable CI perf prerequisite failed: {status}").into());
    }
    if fs::read_to_string("/proc/sys/kernel/perf_event_paranoid")?.trim() != "2" {
        return Err("CI perf setting did not read back as per-task user-space policy 2".into());
    }
    Ok(())
}
#[cfg(not(target_os = "linux"))]
pub(super) fn prepare() -> Result<()> {
    Err("CI perf requires Linux".into())
}
