use super::{LeaseHostError, Result, native_path};
use crate::native;
use reverie_contracts::lease_policy::{PeerArtifactDigest, peer_artifact_digest};
use reverie_core::lease_policy::{LeaseAbsolutePath, PeerMachine, StaticPeerElf, static_peer_elf};
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

const MAX_PEER_ARTIFACT_BYTES: usize = 4 * 1024 * 1024;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ArtifactInode {
    device: u64,
    inode: u64,
}
impl ArtifactInode {
    pub fn device(self) -> u64 {
        self.device
    }
    pub fn inode(self) -> u64 {
        self.inode
    }
    pub fn legacy_text(self) -> String {
        format!("{}-{}", self.device, self.inode)
    }
}
/// Fresh immutable-source bytes/header facts, never mounted or kernel proof.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PeerArtifactObservation {
    path: PathBuf,
    digest: PeerArtifactDigest,
    inode: ArtifactInode,
    elf: StaticPeerElf,
}
impl PeerArtifactObservation {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn digest(&self) -> &PeerArtifactDigest {
        &self.digest
    }
    pub fn inode(&self) -> ArtifactInode {
        self.inode
    }
    pub fn elf(&self) -> StaticPeerElf {
        self.elf
    }
}
/// The path is the existing owner-selected peerBinary setting. It cannot select
/// a file outside the independently checked root-controlled immutable Nix scope.
pub fn observe_peer_artifact(value: &LeaseAbsolutePath) -> Result<PeerArtifactObservation> {
    let path = native_path(value)?;
    immutable(&path)?;
    let snapshot = native::observe_snapshot(&path, MAX_PEER_ARTIFACT_BYTES, |info| {
        info.uid() == 0 && info.mode() & 0o111 != 0 && info.mode() & 0o222 == 0
    })?;
    let (_, machine) = native::system()?;
    let machine = match machine.as_str() {
        "x86_64" => PeerMachine::X86_64,
        "aarch64" => PeerMachine::Aarch64,
        _ => return Err(LeaseHostError::Machine),
    };
    let elf = static_peer_elf(&snapshot.bytes, machine)?;
    immutable(&path)?;
    Ok(PeerArtifactObservation {
        path,
        digest: peer_artifact_digest(&snapshot.bytes),
        inode: ArtifactInode {
            device: snapshot.metadata.dev(),
            inode: snapshot.metadata.ino(),
        },
        elf,
    })
}
fn immutable(path: &Path) -> Result<()> {
    let store = Path::new("/nix/store");
    if path
        .as_os_str()
        .as_bytes()
        .iter()
        .any(|&value| value < 32 || value == 127)
        || path == store
        || !path.starts_with(store)
    {
        return Err(LeaseHostError::ImmutableNix);
    }
    native::canonical_in(path, store)?;
    for ancestor in [Path::new("/"), Path::new("/nix")] {
        let info = fs::symlink_metadata(ancestor)?;
        if !info.is_dir() || info.uid() != 0 || info.mode() & 0o022 != 0 {
            return Err(LeaseHostError::ImmutableNix);
        }
    }
    let info = fs::symlink_metadata(store)?;
    if !info.is_dir() || info.uid() != 0 || (info.mode() & 0o022 != 0 && info.mode() & 0o1000 == 0)
    {
        return Err(LeaseHostError::ImmutableNix);
    }
    let relative = path
        .strip_prefix(store)
        .map_err(|_| LeaseHostError::ImmutableNix)?;
    let mut prefix = store.to_owned();
    for component in relative.components() {
        prefix.push(component);
        let info = fs::symlink_metadata(&prefix)?;
        if info.file_type().is_symlink() || info.uid() != 0 || info.mode() & 0o022 != 0 {
            return Err(LeaseHostError::ImmutableNix);
        }
    }
    if !fs::symlink_metadata(path)?.is_file() {
        return Err(LeaseHostError::ImmutableNix);
    }
    Ok(())
}
#[cfg(test)]
pub(super) fn synthetic_observation(path: &LeaseAbsolutePath) -> PeerArtifactObservation {
    let mut bytes = vec![0; 120];
    bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
    bytes[16..18].copy_from_slice(&2_u16.to_le_bytes());
    bytes[18..20].copy_from_slice(&62_u16.to_le_bytes());
    bytes[32..40].copy_from_slice(&64_u64.to_le_bytes());
    bytes[54..56].copy_from_slice(&56_u16.to_le_bytes());
    bytes[56..58].copy_from_slice(&1_u16.to_le_bytes());
    PeerArtifactObservation {
        path: native_path(path).unwrap(),
        digest: peer_artifact_digest(&bytes),
        inode: ArtifactInode {
            device: 0,
            inode: 0,
        },
        elf: static_peer_elf(&bytes, PeerMachine::X86_64).unwrap(),
    }
}
