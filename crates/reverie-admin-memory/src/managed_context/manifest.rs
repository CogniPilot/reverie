use super::{
    Snapshot,
    wire::{Section, Stage},
};
use nix::{
    fcntl::{OFlag, openat, renameat},
    sys::stat::Mode,
    unistd::{UnlinkatFlags, unlinkat},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Write},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

const NAME: &str = "managed-context.json";

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn section(value: &Section) -> Value {
    json!({"id": value.id, "status": value.status, "chars": value.text.chars().count(),
        "textSha256": digest(&value.text)})
}

fn record(session_id: &str, stage: Stage, snapshot: &Snapshot<'_>) -> Value {
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let mut value = json!({"version": 1, "assurance": "harness-prepared-input-not-model-consumption",
        "at": at, "status": snapshot.status, "stage": stage, "sessionId": session_id,
        "includedTextSha256": digest(&snapshot.text), "includedChars": snapshot.text.chars().count(),
        "sections": []});
    if let Some(issued) = snapshot.issued {
        value["employeeId"] = json!(issued.employee_id);
        value["sessionGeneration"] = json!(issued.session_generation);
        value["issuedDigest"] = json!(issued.digest);
        value["generatedAt"] = json!(issued.generated_at);
        value["sections"] = Value::Array(issued.sections.iter().map(section).collect());
        if let Some(binding) = &issued.runtime_binding {
            value["runtimeBinding"] = json!(binding);
        }
    }
    value
}

pub(super) fn publish(
    path: &Path,
    session_id: &str,
    stage: Stage,
    snapshot: &Snapshot<'_>,
) -> io::Result<()> {
    let parent = path.parent().ok_or_else(crate::refused)?;
    let parent = crate::private_directory::open_private_directory(parent)?;
    let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let parent = File::from(openat(&parent, ".", flags, Mode::empty())?);
    let staged = Temporary::write(
        &parent,
        &serde_json::to_vec(&record(session_id, stage, snapshot))?,
    )?;
    renameat(&parent, staged.name.as_str(), &parent, NAME)?;
    drop(staged);
    parent.sync_all()
}

struct Temporary<'a> {
    directory: &'a File,
    name: String,
}

impl<'a> Temporary<'a> {
    fn write(directory: &'a File, input: &[u8]) -> io::Result<Self> {
        let mut nonce = [0; 16];
        getrandom::getrandom(&mut nonce)
            .map_err(|_| io::Error::other("context manifest entropy unavailable"))?;
        let name = format!(".managed-context-{:032x}.tmp", u128::from_be_bytes(nonce));
        let flags =
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let mut file = File::from(openat(
            directory,
            name.as_str(),
            flags,
            Mode::S_IRUSR | Mode::S_IWUSR,
        )?);
        let temporary = Self { directory, name };
        file.write_all(input)?;
        file.sync_all()?;
        Ok(temporary)
    }
}

impl Drop for Temporary<'_> {
    fn drop(&mut self) {
        let _ = unlinkat(
            self.directory,
            self.name.as_str(),
            UnlinkatFlags::NoRemoveDir,
        );
    }
}
