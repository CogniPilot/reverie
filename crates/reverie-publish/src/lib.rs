//! Reviewed publication for this project's coordinator: open PRs, fast-forward PR branches, set
//! PR text, merge and read CI back, each only from a sealed packet and an approval record bound to
//! the exact reviewed objects. No force-push, ever; every write leaves an intent record first and
//! is read back after.
//!
//! This crate holds the shared checks. `git` and `curl` run with explicit argv and no shell; the
//! token reaches curl only on stdin. Paths to the object store, token and records are arguments,
//! so nothing private is compiled in.
pub mod approval;
pub mod askpass;
pub mod commits;
pub mod custody;
pub mod git;
pub mod github;
pub mod mint;
pub mod packet;
pub mod pull;
pub mod record;
pub mod verify;

use sha2::{Digest, Sha256};

/// Lowercase hex sha256.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The repository's short name (`reverie` for `CogniPilot/reverie`), the form namegate takes.
pub fn short_name(repo: &str) -> Result<&str, String> {
    match repo.split_once('/') {
        Some((owner, name)) if !owner.is_empty() && !name.is_empty() && !name.contains('/') => {
            Ok(name)
        }
        _ => Err(format!("a repository is OWNER/NAME, not {repo:?}")),
    }
}
