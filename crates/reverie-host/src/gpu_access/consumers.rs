use super::*;
use reverie_contracts::worker_config::EffectiveWorkerConfig;
use reverie_core::posix_path::PosixPath;
use std::{env, fs};
/// Raw-config consumers intentionally keep an owner request queued. This is
/// mere installed-file presence, never a systemd action or an approval flag.
pub fn installed_consumers(config: &EffectiveWorkerConfig) -> Result<bool> {
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
    let roots = if default == configured {
        vec![default]
    } else {
        vec![default, configured]
    };
    if reverie_contracts::gpu_access::has_resource_actor(config) {
        return Ok(true);
    }
    for root in roots {
        let path = root.join(&PosixPath::from_scalar_text(
            "systemd/user/reverie-owner-terminal.service",
        ));
        // os.path.lexists suppresses OSError/ValueError and follows ancestors;
        // this weak data check must never be presented as custody/permission.
        if native::python_path(&path.codepoints())
            .is_ok_and(|path| fs::symlink_metadata(path).is_ok())
        {
            return Ok(true);
        }
    }
    Ok(false)
}
