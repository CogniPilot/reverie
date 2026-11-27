//! Report or remove the backups that closed, superseded updates left behind.
//!
//! Only storage this tool placed is ever named: the `snapshot` and
//! `retained-copy` directories inside an operation it can read, and the
//! `rehearsal` and `snapshot` directories inside a rehearsal directory that
//! the operation journaled before writing there. Operations are found by
//! following the journaled claim handovers back from the active operation,
//! never by listing a directory or matching names. Journals, plans and
//! containers are kept.
use super::*;
use crate::operation::RecordedRoot;
use std::{
    collections::BTreeSet,
    fs, io,
    os::unix::fs::{MetadataExt, PermissionsExt},
};
#[cfg(test)]
mod tests;

const MAX_HISTORY: usize = 4096;
const REMOVAL_UNCONFIRMED: &str = "DEPLOYMENT_PRUNE_REMOVAL_UNCONFIRMED";
const NOT_A_DIRECTORY: &str = "DEPLOYMENT_PRUNE_ARTIFACT_NOT_DIRECTORY";

struct Artifact {
    kind: &'static str,
    path: PathBuf,
    bytes: u64,
}
#[derive(Clone, Copy)]
struct Policy {
    apply: bool,
    keep: usize,
}
/// Newest first: rehearsal directories already attributed, and how many
/// operations so far still hold storage.
#[derive(Default)]
struct Walk {
    roots: BTreeSet<(u64, u64)>,
    holding: usize,
}

/// Present as a real directory. A link or file under a tool-owned name is
/// never followed or removed.
fn directory(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
        Ok(info) => require(info.is_dir(), NOT_A_DIRECTORY).map(|()| true),
    }
}
/// Allocated bytes, for the report only.
fn allocated(path: &Path) -> u64 {
    let mut total = 0_u64;
    let mut pending = vec![path.to_path_buf()];
    while let Some(path) = pending.pop() {
        let Ok(info) = fs::symlink_metadata(&path) else {
            continue;
        };
        total = total.saturating_add(info.blocks().saturating_mul(512));
        if info.is_dir()
            && let Ok(entries) = fs::read_dir(&path)
        {
            pending.extend(entries.flatten().map(|entry| entry.path()));
        }
    }
    total
}
/// The journaled rehearsal directory is still that same private directory.
fn current(root: &RecordedRoot) -> Result<bool> {
    match fs::symlink_metadata(&root.path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
        Ok(info) => Ok(info.is_dir()
            && (info.dev(), info.ino()) == root.identity
            && info.uid() == nix::unistd::geteuid().as_raw()
            && info.mode() & 0o777 == 0o700),
    }
}
fn artifacts(operation: &Operation, roots: &mut BTreeSet<(u64, u64)>) -> Result<Vec<Artifact>> {
    let mut places = vec![
        ("backup", operation.directory.join("snapshot")),
        ("retained-copy", operation.directory.join("retained-copy")),
    ];
    // A rehearsal directory used again belongs to the newest operation that
    // journaled it; an older operation no longer owns what is inside.
    if let Some(root) = operation.rehearsal_root()?
        && current(&root)?
        && roots.insert(root.identity)
    {
        places.push(("rehearsal", root.path.join("rehearsal")));
        places.push(("staged-archive", root.path.join("snapshot")));
    }
    let mut found = Vec::new();
    for (kind, path) in places {
        if directory(&path)? {
            found.push(Artifact {
                kind,
                bytes: allocated(&path),
                path,
            });
        }
    }
    Ok(found)
}
/// A restored copy keeps the modes of the console it mirrors, including
/// directories its owner cannot write. Every parent here is private to the
/// owner, so no other user can swap an entry between the look and the change.
fn grant_owner_access(path: &Path) -> io::Result<()> {
    let mut pending = vec![path.to_path_buf()];
    while let Some(path) = pending.pop() {
        let info = fs::symlink_metadata(&path)?;
        if !info.is_dir() {
            continue;
        }
        if info.mode() & 0o700 != 0o700 {
            fs::set_permissions(
                &path,
                fs::Permissions::from_mode(info.mode() & 0o7777 | 0o700),
            )?;
        }
        for entry in fs::read_dir(&path)? {
            pending.push(entry?.path());
        }
    }
    Ok(())
}
fn remove(path: &Path) -> Result<()> {
    let removed = match fs::remove_dir_all(path) {
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            grant_owner_access(path).and_then(|()| fs::remove_dir_all(path))
        }
        other => other,
    };
    removed.map_err(|_| DeploymentError::new(REMOVAL_UNCONFIRMED))?;
    installation::sync_directory(
        path.parent()
            .ok_or_else(|| DeploymentError::new(REMOVAL_UNCONFIRMED))?,
    )
}
/// The intent is journaled before the first removal and the completion after
/// the last. Removing what is already condemned may be repeated.
fn prune(operation: &Operation, found: &[Artifact]) -> Result<()> {
    if !operation.record_present("artifacts-prune-attempt")? {
        let paths = found
            .iter()
            .map(|artifact| &artifact.path)
            .collect::<Vec<_>>();
        operation.record("artifacts-prune-attempt", &json!({"artifacts":paths}))?;
    }
    for artifact in found {
        remove(&artifact.path)?;
    }
    if !operation.record_present("artifacts-pruned")? {
        let bytes = found.iter().map(|artifact| artifact.bytes).sum::<u64>();
        operation.record("artifacts-pruned", &json!({"allocatedBytes":bytes}))?;
    }
    Ok(())
}
fn row(
    operation: &Operation,
    successor: Option<&str>,
    walk: &mut Walk,
    policy: Policy,
) -> Option<Value> {
    let id = &operation.plan.operation;
    let found = match artifacts(operation, &mut walk.roots) {
        Ok(found) => found,
        Err(error) => {
            return Some(json!({"operation":id,"disposition":"unconfirmed","code":error.code()}));
        }
    };
    if found.is_empty() {
        return None;
    }
    walk.holding += 1;
    let disposition = match successor {
        None => "active",
        Some(_) if walk.holding <= policy.keep => "kept-recent",
        Some(successor) => match operation.closed_and_superseded_by(successor) {
            Ok(true) => "prunable",
            Ok(false) => "not-closed",
            Err(_) => "unconfirmed",
        },
    };
    let listed = found
        .iter()
        .map(|artifact| {
            json!({"kind":artifact.kind,"path":artifact.path,"allocatedBytes":artifact.bytes})
        })
        .collect::<Vec<_>>();
    let bytes = found.iter().map(|artifact| artifact.bytes).sum::<u64>();
    let mut row = json!({"operation":id,"disposition":disposition,"allocatedBytes":bytes,
        "artifacts":listed});
    if disposition == "prunable" && policy.apply {
        match prune(operation, &found) {
            Ok(()) => row["removed"] = json!(true),
            Err(error) => {
                row["removed"] = json!(false);
                row["code"] = json!(error.code());
            }
        }
    }
    Some(row)
}
impl DeploymentService {
    /// The active operation and, behind it, each operation whose claim was
    /// handed over, newest first. The history ends at the first operation
    /// this installation cannot read; nothing older is considered.
    fn claim_history(&self) -> Result<(Vec<Operation>, Option<&'static str>)> {
        let claim = self
            .installation
            .state
            .join("console-deployment-active.json");
        if fs::symlink_metadata(&claim).is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
        {
            return Ok((Vec::new(), None));
        }
        let active = self.operation(&claim::selected(&self.installation)?)?;
        let mut seen = BTreeSet::from([active.plan.operation.clone()]);
        let mut history = vec![active];
        loop {
            let newest_unread = history.last().expect("active operation").predecessor()?;
            let Some(previous) = newest_unread else {
                return Ok((history, None));
            };
            if history.len() >= MAX_HISTORY || !seen.insert(previous.clone()) {
                return Ok((history, Some("DEPLOYMENT_CLAIM_HISTORY_INVALID")));
            }
            match self.operation(&previous) {
                Ok(operation) => history.push(operation),
                Err(error) => return Ok((history, Some(error.code()))),
            }
        }
    }
    /// Report what closed, superseded operations still hold, or with `apply`
    /// remove it. The active operation and the `keep` most recent operations
    /// holding storage are always kept, as is any operation that did not
    /// end ready, restored or refused before a later one took its claim.
    pub fn prune_deployments(&self, apply: bool, keep: usize) -> Result<Value> {
        let (history, ends) = self.claim_history()?;
        let policy = Policy { apply, keep };
        let mut walk = Walk::default();
        let mut rows = Vec::new();
        for (index, operation) in history.iter().enumerate() {
            let successor = index
                .checked_sub(1)
                .map(|newer| history[newer].plan.operation.as_str());
            rows.extend(row(operation, successor, &mut walk, policy));
        }
        let total = |wanted: fn(&Value) -> bool| {
            rows.iter()
                .filter(|row| wanted(row))
                .filter_map(|row| row["allocatedBytes"].as_u64())
                .sum::<u64>()
        };
        Ok(json!({
            "success":rows.iter().all(|row| row["removed"] != false),
            "applied":apply,
            "keep":keep,
            "historyEndedBy":ends,
            "prunableBytes":total(|row| row["disposition"] == "prunable"),
            "removedBytes":total(|row| row["removed"] == true),
            "keptBytes":total(|row| row["disposition"] != "prunable"),
            "operations":rows,
        }))
    }
}
