//! Fixed private credential bootstrap. Correlation DATA never grants a provider start.
mod filesystem;
mod input;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{error::Error, ffi::OsString, io::Write, process::Stdio};
pub(super) type Result<T> = std::result::Result<T, Failure>;
#[derive(Debug)]
pub(super) struct Failure {
    phase: &'static str,
    cause: Box<dyn Error + Send + Sync>,
    cleanup: Vec<Self>,
}
impl Failure {
    fn new(phase: &'static str, cause: impl Error + Send + Sync + 'static) -> Self {
        Self {
            phase,
            cause: Box::new(cause),
            cleanup: Vec::new(),
        }
    }
    fn refused(phase: &'static str) -> Self {
        Self::new(phase, std::io::Error::other(phase))
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} ({} cleanup failures)",
            self.phase,
            self.cleanup.len()
        )
    }
}
impl Error for Failure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.cause.as_ref())
    }
}
pub(super) fn join<T>(primary: Result<T>, finalizer: Result<()>) -> Result<T> {
    match (primary, finalizer) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(mut error), Err(cleanup)) => {
            error.cleanup.push(cleanup);
            Err(error)
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Home {
    dev: u64,
    ino: u64,
}
pub(super) struct Arguments {
    digest: String,
    home: Home,
}
pub(super) fn arguments(args: &[OsString]) -> Option<Result<Arguments>> {
    if args.first().is_none_or(|v| v != "worker-client")
        || args.get(1).is_none_or(|v| v != "credential-install")
    {
        return None;
    }
    Some(parse_arguments(args))
}
fn decimal(value: &OsString, positive: bool) -> Result<u64> {
    let text = value
        .to_str()
        .ok_or_else(|| Failure::refused("home-identity"))?;
    let value = text
        .parse::<u64>()
        .map_err(|error| Failure::new("home-identity", error))?;
    if value.to_string() != text || (positive && value == 0) {
        return Err(Failure::refused("home-identity"));
    }
    Ok(value)
}
fn parse_arguments(args: &[OsString]) -> Result<Arguments> {
    let [_, _, flag, digest, dev_flag, dev, ino_flag, ino] = args else {
        return Err(Failure::refused("arguments"));
    };
    let text = digest
        .to_str()
        .ok_or_else(|| Failure::refused("arguments"))?;
    if flag != "--expected-digest"
        || dev_flag != "--home-dev"
        || ino_flag != "--home-ino"
        || !valid_digest(text)
    {
        return Err(Failure::refused("arguments"));
    }
    Ok(Arguments {
        digest: text.to_owned(),
        home: Home {
            dev: decimal(dev, false)?,
            ino: decimal(ino, true)?,
        },
    })
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}
fn session() -> Result<String> {
    let sid =
        std::env::var("REVERIE_SESSION_ID").map_err(|error| Failure::new("session", error))?;
    if !valid_session(&sid) {
        return Err(Failure::refused("session"));
    }
    Ok(sid)
}
fn valid_session(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, b)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_digit() || matches!(b, b'a'..=b'f')
            }
        })
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CapsuleReadback {
    version: u8,
    purpose: String,
    manifest_digest: String,
    entry_sha256: String,
    files_checked: u16,
    node_major: u8,
    owner_uid: u32,
}
fn qualify(digest: &str) -> Result<()> {
    let args = ["worker-client", "status", "--expected-digest", digest].map(OsString::from);
    let mut command = super::command(&args, []).map_err(Failure::refused)?;
    let output = command
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|error| Failure::new("capsule-check", error))?;
    if !output.status.success() || output.stdout.len() > 4096 {
        return Err(Failure::refused("capsule-check"));
    }
    let value: CapsuleReadback = serde_json::from_slice(&output.stdout)
        .map_err(|error| Failure::new("capsule-check", error))?;
    if value.version != 1
        || value.purpose != "reverie-worker-client-readback-v1"
        || value.manifest_digest != digest
        || value.node_major != 22
        || value.owner_uid != 0
        || !(4..=256).contains(&value.files_checked)
        || !valid_digest(&value.entry_sha256)
    {
        return Err(Failure::refused("capsule-check"));
    }
    let mut canonical =
        serde_json::to_vec(&value).map_err(|error| Failure::new("capsule-check", error))?;
    canonical.push(b'\n');
    if canonical != output.stdout {
        return Err(Failure::refused("capsule-check"));
    }
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt<'a> {
    version: u8,
    purpose: &'static str,
    manifest_digest: &'a str,
    session_id: &'a str,
    token_digest: String,
    home_dev: String,
    home_ino: String,
}
pub(super) fn run(arguments: Arguments) -> Result<()> {
    qualify(&arguments.digest)?;
    let session = session()?;
    let token = input::read()?;
    filesystem::install(&token, arguments.home)?;
    let receipt = Receipt {
        version: 1,
        purpose: "reverie-worker-credential-installed-v1",
        manifest_digest: &arguments.digest,
        session_id: &session,
        token_digest: format!("{:x}", Sha256::digest(&token)),
        home_dev: arguments.home.dev.to_string(),
        home_ino: arguments.home.ino.to_string(),
    };
    let bytes = serde_json::to_string(&receipt).map_err(|error| Failure::new("receipt", error))?;
    let mut output = std::io::stdout().lock();
    output
        .write_all(bytes.as_bytes())
        .and_then(|()| output.write_all(b"\n"))
        .map_err(|error| Failure::new("receipt-write", error))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_arguments_and_canonical_full_identity() {
        let values = [
            "worker-client",
            "credential-install",
            "--expected-digest",
            &"a".repeat(64),
            "--home-dev",
            "123",
            "--home-ino",
            "456",
        ]
        .map(OsString::from);
        assert!(arguments(&values).unwrap().is_ok());
        let mut malformed = values.clone();
        malformed[5] = OsString::from("0123");
        assert!(arguments(&malformed).unwrap().is_err());
        assert!(!valid_session("first"));
        assert!(valid_session("11111111-1111-4111-8111-111111111111"));
        assert!(!valid_digest(&"A".repeat(64)));
    }
}
