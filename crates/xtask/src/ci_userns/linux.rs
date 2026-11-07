use super::*;
use std::{
    fs,
    io::Write,
    os::unix::fs::MetadataExt,
    path::PathBuf,
    process::{Command, Stdio},
};

pub(super) fn prepare() -> Result<()> {
    let actions = std::env::var("GITHUB_ACTIONS").ok();
    let environment = std::env::var("REVERIE_CI_RUNNER_ENVIRONMENT").ok();
    let os = std::env::var("RUNNER_OS").ok();
    let ci = std::env::var("CI").ok();
    // Refuse before reading/profiling any tool or invoking sudo on local hosts.
    declared_runner(
        actions.as_deref(),
        environment.as_deref(),
        os.as_deref(),
        ci.as_deref(),
    )?;
    ubuntu24(&fs::read_to_string("/etc/os-release")?)?;
    let selected = selected_unshare()?;
    let rules = profile(&selected)?;
    trusted_system_tool(Path::new("/usr/bin/sudo"))?;
    trusted_system_tool(Path::new("/usr/sbin/apparmor_parser"))?;
    eprintln!(
        "+ disposable CI exact userns profile attachment: {}",
        selected.display()
    );
    let mut command = Command::new("/usr/bin/sudo");
    command.args([
        "--non-interactive",
        "--",
        "/usr/sbin/apparmor_parser",
        "--replace",
        "--skip-cache",
        "--base",
        "/etc/apparmor.d",
    ]);
    load(&mut command, rules.as_bytes())?;
    eprintln!("CI prerequisite loaded; actual namespace/root/data controls remain required");
    Ok(())
}
fn selected_unshare() -> Result<PathBuf> {
    let path = std::env::var_os("PATH").ok_or("declared Nix development PATH is required")?;
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join("unshare");
        let metadata = match fs::metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_file() || metadata.mode() & 0o111 == 0 {
            continue;
        }
        // Validate the FIRST executable PATH match; never profile a later tool
        // while the real test would still execute an earlier decoy.
        let selected = candidate.canonicalize()?;
        profile(&selected)?;
        trusted_store_tool(&selected)?;
        return Ok(selected);
    }
    Err("Nix util-linux unshare missing from declared development PATH".into())
}
fn trusted_store_tool(path: &Path) -> Result<()> {
    let file = fs::metadata(path)?;
    if !file.is_file() || file.uid() != 0 || file.mode() & 0o6222 != 0 || file.mode() & 0o111 == 0 {
        return Err("Nix unshare must be a root-owned readonly non-set-ID executable".into());
    }
    let mut current = path.parent().ok_or("unshare parent missing")?;
    loop {
        let info = fs::metadata(current)?;
        let writable = info.mode() & 0o022;
        // The root-owned Nix store may be group-writable+sticky. Sticky plus
        // each selected root-owned readonly entry bars nonroot replacement.
        let sticky_store = current == Path::new("/nix/store")
            && info.mode() & 0o1000 != 0
            && writable & 0o002 == 0;
        if !info.is_dir() || info.uid() != 0 || (writable != 0 && !sticky_store) {
            return Err("Nix unshare parent is not protected from nonroot replacement".into());
        }
        if current == Path::new("/") {
            break;
        }
        current = current.parent().ok_or("unshare ancestor missing")?;
    }
    Ok(())
}
fn trusted_system_tool(path: &Path) -> Result<()> {
    let file = fs::metadata(path)?;
    if !file.is_file() || file.uid() != 0 || file.mode() & 0o022 != 0 || file.mode() & 0o111 == 0 {
        return Err("CI sudo/AppArmor parser must be root-owned system executables".into());
    }
    Ok(())
}
pub(super) fn load(command: &mut Command, rules: &[u8]) -> Result<()> {
    // One bounded write, then close stdin and wait even if the write fails.
    // This thin runner neither spawns a shell nor abandons its sudo child.
    if rules.len() > 4096 {
        return Err("bounded CI profile exceeded".into());
    }
    let mut child = command.stdin(Stdio::piped()).spawn()?;
    let sent = match child.stdin.take() {
        Some(mut input) => input.write_all(rules),
        None => Err(std::io::Error::other("profile stdin unavailable")),
    };
    let waited = child.wait();
    match (sent, waited) {
        (Ok(()), Ok(status)) if status.success() => Ok(()),
        (sent, waited) => {
            Err(format!("CI profile load unconfirmed: stdin={sent:?}; process={waited:?}").into())
        }
    }
}
