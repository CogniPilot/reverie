use super::*;
use reverie_contracts::worker_config::EffectiveWorkerConfig;
use reverie_core::posix_path::PosixPath;
use std::{env, fs};
/// Raw-config consumers intentionally keep an owner request queued. This is
/// mere installed-file presence, never a systemd action or an approval flag.
pub fn installed_consumers(config: &EffectiveWorkerConfig) -> Result<bool> {
    let roots = terminal_roots()?;
    Ok(reverie_contracts::gpu_access::has_resource_actor(config) || terminal_present(roots))
}
/// The protected website transition does not rebind an installed terminal.
pub fn installed_terminal() -> Result<bool> {
    terminal_present_checked(&terminal_paths()?)
}
pub(super) fn terminal_paths() -> Result<Vec<std::path::PathBuf>> {
    terminal_roots()?
        .iter()
        .map(|root| {
            let leaf = terminal_leaf(root);
            Ok(native::python_path(&leaf.codepoints())?)
        })
        .collect()
}
pub(super) fn terminal_present_checked(paths: &[std::path::PathBuf]) -> Result<bool> {
    for path in paths {
        match fs::symlink_metadata(path) {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(false)
}
fn terminal_roots() -> Result<Vec<PosixPath>> {
    // Source computes Path.home and both roots before the actor-key shortcut.
    let home = match env::var_os("HOME") {
        Some(value) => native::python_text(std::path::Path::new(&value)),
        None => native::home_directory(None)?,
    };
    let home = PosixPath::try_new(&home).expect("native home codepoints");
    let default = home.join(&PosixPath::from_scalar_text(".config"));
    let configured = env::var_os("XDG_CONFIG_HOME")
        .map(|value| {
            PosixPath::try_new(&native::python_text(std::path::Path::new(&value)))
                .expect("native config home codepoints")
        })
        .unwrap_or_else(|| default.clone());
    Ok(if default == configured {
        vec![default]
    } else {
        vec![default, configured]
    })
}
fn terminal_present(roots: Vec<PosixPath>) -> bool {
    for root in roots {
        let path = terminal_leaf(&root);
        // os.path.lexists suppresses OSError/ValueError and follows ancestors;
        // this weak data check must never be presented as custody/permission.
        if native::python_path(&path.codepoints())
            .is_ok_and(|path| fs::symlink_metadata(path).is_ok())
        {
            return true;
        }
    }
    false
}

fn terminal_leaf(root: &PosixPath) -> PosixPath {
    root.join(&PosixPath::from_scalar_text(
        "systemd/user/reverie-owner-terminal.service",
    ))
}
