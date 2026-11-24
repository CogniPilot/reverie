//! Read the office credential a boxed laptop launcher selected for this process.
//!
//! The office refuses every agent request from a laptop that does not present
//! this credential. Absence selects the ordinary client path; a selected file
//! that cannot be trusted fails closed rather than falling back to a password.
use crate::Result;
use nix::{fcntl::OFlag, unistd::getuid};
use std::{
    env,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path},
};

const SELECTION: &str = "REVERIE_WORKER_IDENTITY_FILE";
const LIMIT: usize = 2048;
const UNAVAILABLE: &str = "this laptop's office credential is unavailable";

/// The credential to present, when the launcher selected one.
pub(super) fn selected() -> Result<Option<String>> {
    match env::var_os(SELECTION) {
        None => Ok(None),
        Some(path) => read(Path::new(&path)).map(Some).ok_or(UNAVAILABLE),
    }
}

fn read(path: &Path) -> Option<String> {
    if !canonical(path) || !private_parents(path) {
        return None;
    }
    let flags = OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(flags.bits())
        .open(path)
        .ok()?;
    let info = file.metadata().ok()?;
    if !info.is_file()
        || info.uid() != getuid().as_raw()
        || info.mode() & 0o777 != 0o600
        || info.nlink() != 1
    {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(LIMIT as u64 + 2).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let token = text.strip_suffix('\n').unwrap_or(&text);
    valid(token).then(|| token.to_owned())
}

fn canonical(path: &Path) -> bool {
    let mut parts = path.components();
    parts.next() == Some(Component::RootDir)
        && parts.all(|part| matches!(part, Component::Normal(_)))
}

/// Every directory above the file belongs to root or this user and admits no
/// other writer, so nobody else could have substituted the credential.
fn private_parents(path: &Path) -> bool {
    let uid = getuid().as_raw();
    path.ancestors().skip(1).all(|directory| {
        fs::symlink_metadata(directory).is_ok_and(|info| {
            let sticky_root = info.uid() == 0 && info.mode() & 0o1000 != 0;
            info.is_dir()
                && (info.uid() == 0 || info.uid() == uid)
                && (info.mode() & 0o022 == 0 || sticky_root)
        })
    })
}

fn valid(token: &str) -> bool {
    let Some((binding, signature)) = token.split_once('.') else {
        return false;
    };
    token.len() <= LIMIT
        && !binding.is_empty()
        && binding
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        && signature.len() == 64
        && signature
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::valid;

    #[test]
    fn accepts_only_the_issued_credential_shape() {
        let signature = "0123456789abcdef".repeat(4);
        assert!(valid(&format!("WzEsImRvY2tlciJd.{signature}")));
        for token in [
            format!(".{signature}"),
            format!("binding.{}", &signature[1..]),
            format!("binding.{}", signature.to_uppercase()),
            format!("bind ing.{signature}"),
            format!("binding.{signature}.extra"),
            format!("{}.{signature}", "a".repeat(2048)),
            "binding".into(),
        ] {
            assert!(!valid(&token), "{token}");
        }
    }
}
