//! Installer-selected immutable input observations. Returned bytes and inode
//! identities are DATA, never a program, website, current-owner or effect grant.
#[cfg(test)]
mod tests;
use super::{code, files::Descriptors, *};
use code::files::{Stamp, check_end, nix_path};
use reverie_contracts::resource_actor::{
    ArtifactReference, CodeFile, NativeResourceClientManifest,
};
use std::{fs, io::Read, os::unix::fs::MetadataExt, path::Path, time::Instant};

pub enum ImmutableInputKind {
    Client,
    Provenance,
    Startup,
}
impl ImmutableInputKind {
    fn maximum(&self) -> u64 {
        match self {
            Self::Client => 8192,
            Self::Provenance | Self::Startup => 65536,
        }
    }
}
pub struct ObservedImmutableInput {
    bytes: Vec<u8>,
    identity: [u64; 2],
}
impl ObservedImmutableInput {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn identity(&self) -> [u64; 2] {
        self.identity
    }
}
pub struct ObservedNativeClient {
    identity: [u64; 2],
}
impl ObservedNativeClient {
    pub fn identity(&self) -> [u64; 2] {
        self.identity
    }
}
#[derive(Default)]
#[must_use = "retain the original observer and actor hold after uncertain close"]
pub struct ImmutableInputObserver {
    close_uncertain: bool,
}
impl ImmutableInputObserver {
    pub fn observe_artifact(
        &mut self,
        selected: &ArtifactReference,
        kind: ImmutableInputKind,
        end: Instant,
    ) -> Result<ObservedImmutableInput> {
        self.current(end)?;
        let path = nix_path(&selected.path)?;
        let mut files = Descriptors::default();
        let body = read_artifact(&mut files, &path, selected, kind.maximum(), end);
        files.finish(body, &mut self.close_uncertain)
    }
    /// Verifies the already-decoded v2 native selection without executing it.
    pub fn observe_native_client(
        &mut self,
        selected: &NativeResourceClientManifest,
        end: Instant,
    ) -> Result<ObservedNativeClient> {
        self.current(end)?;
        let path = nix_path(selected.executable())?;
        let mut files = Descriptors::default();
        let body = read_client(&mut files, &path, selected, end);
        files.finish(body, &mut self.close_uncertain)
    }
    fn current(&self, end: Instant) -> Result<()> {
        need(!self.close_uncertain, "IMMUTABLE_INPUT_CLOSE_UNCONFIRMED")?;
        check_end(end)
    }
}
fn open(
    files: &mut Descriptors,
    path: &Path,
    maximum: u64,
    end: Instant,
) -> Result<(usize, fs::Metadata)> {
    check_end(end)?;
    need(
        fs::canonicalize(path)? == path,
        "CANONICAL_HOST_CODE_REQUIRED",
    )?;
    let index = files.retain(code::read_open(path)?);
    let info = files.get(index).metadata()?;
    need(
        info.is_file()
            && info.uid() == 0
            && info.mode() & 0o222 == 0
            && (1..=maximum).contains(&info.len()),
        "IMMUTABLE_INPUT_CUSTODY",
    )?;
    Ok((index, info))
}
fn unchanged(files: &Descriptors, index: usize, info: &fs::Metadata, end: Instant) -> Result<()> {
    need(
        Stamp::of(&files.get(index).metadata()?) == Stamp::of(info),
        "IMMUTABLE_INPUT_CHANGED",
    )?;
    check_end(end)
}
fn read_artifact(
    files: &mut Descriptors,
    path: &Path,
    selected: &ArtifactReference,
    maximum: u64,
    end: Instant,
) -> Result<ObservedImmutableInput> {
    use sha2::{Digest, Sha256};
    let (index, info) = open(files, path, maximum, end)?;
    let mut bytes = Vec::new();
    files
        .get_mut(index)
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    need(
        bytes.len() as u64 == info.len()
            && bytes.len() as u64 <= maximum
            && JournalDigest::parse(&format!("{:x}", Sha256::digest(&bytes))).expect("SHA256")
                == selected.sha256,
        "IMMUTABLE_INPUT_BYTES_CHANGED",
    )?;
    unchanged(files, index, &info, end)?;
    Ok(ObservedImmutableInput {
        bytes,
        identity: [info.dev(), info.ino()],
    })
}
fn read_client(
    files: &mut Descriptors,
    path: &Path,
    selected: &NativeResourceClientManifest,
    end: Instant,
) -> Result<ObservedNativeClient> {
    let (index, info) = open(files, path, code::MAX_CODE_FILE, end)?;
    need(
        info.mode() & 0o111 != 0,
        "NATIVE_CLIENT_EXECUTABLE_REQUIRED",
    )?;
    let mut magic = [0; 4];
    files.get_mut(index).read_exact(&mut magic)?;
    need(magic == *b"\x7fELF", "NATIVE_CLIENT_ELF_REQUIRED")?;
    use std::io::{Seek, SeekFrom};
    files.get_mut(index).seek(SeekFrom::Start(0))?;
    code::hash(
        files.get_mut(index),
        &CodeFile {
            path: selected.executable().clone(),
            sha256: selected.executable_digest().clone(),
            bytes: info.len(),
        },
        end,
    )?;
    unchanged(files, index, &info, end)?;
    Ok(ObservedNativeClient {
        identity: [info.dev(), info.ino()],
    })
}
