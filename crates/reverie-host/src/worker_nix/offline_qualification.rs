//! Read pinned private qualification evidence without invoking Docker.
mod profiles;
#[cfg(test)]
mod tests;
use crate::native;
pub use profiles::inventory;
use reverie_contracts::worker_nix::offline_qualification::{
    EvidenceKind, EvidenceReference, Receipt, Target,
};
use sha2::{Digest, Sha256};
use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

const MAX_TARGET: usize = 8 * 1024 * 1024;
const MAX_EVIDENCE: usize = 1024 * 1024;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Private file observations bound to the byte-exact target returned here.
pub struct QualifiedTarget {
    pub bytes: Vec<u8>,
    pub digest: String,
    pub evidence_paths: Vec<PathBuf>,
}

pub fn inspect(path: &Path, now: f64) -> Result<QualifiedTarget> {
    let uid = nix::unistd::getuid().as_raw();
    let bytes = read(path, MAX_TARGET, uid)?;
    let target = Target::decode(&bytes, now)?;
    let [(d2_kind, d2_ref), (can_kind, can_ref)] = target.evidence();
    let mut evidence_paths = Vec::new();
    let d2 = receipt(&target, d2_kind, d2_ref, uid, &mut evidence_paths)?;
    let can = receipt(&target, can_kind, can_ref, uid, &mut evidence_paths)?;
    d2.match_employee(&can)?;
    Ok(QualifiedTarget {
        digest: format!("sha256:{:x}", Sha256::digest(&bytes)),
        bytes,
        evidence_paths,
    })
}

fn read(path: &Path, limit: usize, uid: u32) -> Result<Vec<u8>> {
    let snapshot = native::observe_with_ancestors(path, limit, |metadata| {
        metadata.uid() == uid && metadata.nlink() == 1 && metadata.mode() & 0o7777 == 0o600
    })?;
    Ok(snapshot.bytes)
}

fn receipt(
    target: &Target,
    kind: EvidenceKind,
    claimed: &EvidenceReference,
    uid: u32,
    paths: &mut Vec<PathBuf>,
) -> Result<Receipt> {
    let bytes = pinned(claimed, uid, "validation receipt changed", paths)?;
    let receipt = Receipt::decode(&bytes, kind, target)?;
    let report = read(receipt.report().path(), MAX_EVIDENCE, uid)?;
    receipt.verify_report(&report)?;
    paths.push(receipt.report().path().to_owned());
    if let Some(probe) = receipt.probe() {
        pinned(probe, uid, "actual own-shell probe bytes changed", paths)?;
    }
    Ok(receipt)
}

fn pinned(
    reference: &EvidenceReference,
    uid: u32,
    message: &'static str,
    paths: &mut Vec<PathBuf>,
) -> Result<Vec<u8>> {
    let bytes = read(reference.path(), MAX_EVIDENCE, uid)?;
    reference.verify(&bytes, message)?;
    paths.push(reference.path().to_owned());
    Ok(bytes)
}
