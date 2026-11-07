//! Explicit disposable-runner prerequisite, never part of ordinary verification
//! or installed product startup. Environment declarations prevent accidental
//! local use; they are not authority. Ordinary sudo is the permission boundary.
#[cfg(target_os = "linux")]
mod linux;
#[cfg(test)]
mod tests;
use std::error::Error;
#[cfg(any(target_os = "linux", test))]
use std::path::Path;
type Result<T> = std::result::Result<T, Box<dyn Error>>;

pub(super) fn prepare() -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        linux::prepare()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(
            "prepare-ci-userns requires a declared disposable Ubuntu24.04 GitHub-hosted Linux runner"
                .into(),
        )
    }
}
#[cfg(any(target_os = "linux", test))]
fn declared_runner(
    actions: Option<&str>,
    environment: Option<&str>,
    os: Option<&str>,
    ci: Option<&str>,
) -> Result<()> {
    if actions != Some("true")
        || environment != Some("github-hosted")
        || os != Some("Linux")
        || ci != Some("true")
    {
        return Err("prepare-ci-userns requires a declared disposable Ubuntu24.04 GitHub-hosted Linux runner; it never configures local/self-hosted machines".into());
    }
    Ok(())
}
#[cfg(any(target_os = "linux", test))]
fn ubuntu24(release: &str) -> Result<()> {
    let field = |name: &str| {
        let prefix = format!("{name}=");
        let mut found = release
            .lines()
            .filter_map(|line| line.strip_prefix(&prefix));
        let value = found.next()?;
        if found.next().is_some() {
            return None;
        }
        Some(
            value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .unwrap_or(value),
        )
    };
    if field("ID") != Some("ubuntu") || field("VERSION_ID") != Some("24.04") {
        return Err(
            "prepare-ci-userns supports only the declared Ubuntu24.04 disposable runner".into(),
        );
    }
    Ok(())
}
#[cfg(any(target_os = "linux", test))]
fn profile(path: &Path) -> Result<String> {
    let path = path
        .to_str()
        .ok_or("Nix unshare attachment must be ASCII")?;
    let relative = path
        .strip_prefix("/nix/store/")
        .ok_or("exact immutable Nix unshare required")?;
    let fields = relative.split('/').collect::<Vec<_>>();
    if fields.len() != 3
        || fields[1] != "bin"
        || fields[2] != "unshare"
        || !fields[0].split_once('-').is_some_and(|(hash, name)| {
            hash.len() == 32
                && hash
                    .bytes()
                    .all(|v| b"0123456789abcdfghijklmnpqrsvwxyz".contains(&v))
                && name.starts_with("util-linux-")
        })
        || !path
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || b"/._+-".contains(&v))
    {
        return Err("exact immutable Nix util-linux unshare path required; no profile metacharacters/selectors".into());
    }
    // The closed ASCII spelling excludes quotes, escapes and glob characters;
    // quote it anyway. No caller-selected name, rule, include or program exists.
    let value = format!(
        "abi <abi/4.0>,\ninclude <tunables/global>\nprofile reverie-ci-owned-memory-userns \"{path}\" flags=(unconfined) {{\n  userns,\n}}\n"
    );
    if value.len() > 4096 {
        return Err("bounded CI profile exceeded".into());
    }
    Ok(value)
}
