//! Lifecycle operations over the existing workspace and reservation formats.
use super::{METADATA, Result, TaskWorkspaces, WorkspaceError};
use crate::lease::{self, LeaseBase};
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, DirBuilder, OpenOptions},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

impl TaskWorkspaces {
    /// Create an allocated workspace and its reservation under the operation lock.
    pub fn create(&self, base: &LeaseBase, name: &str) -> Result<PathBuf> {
        let _operation = self.operation(name)?;
        let workspace = self.path(name)?;
        DirBuilder::new().mode(0o700).create(&workspace)?;
        self.reserve(base, &workspace, false)?;
        self.publish(
            &workspace,
            Map::from_iter([
                ("id".into(), json!(name)),
                ("status".into(), json!("allocated")),
                ("created_at".into(), json!(lease::now())),
            ]),
        )?;
        Ok(workspace)
    }

    /// Record a handoff for a verified terminal workspace before releasing its reservation.
    pub fn finish(&self, base: &LeaseBase, name: &str, handoff: &str) -> Result<()> {
        if handoff.trim().is_empty() {
            return Err(WorkspaceError::Handoff);
        }
        let _operation = self.operation(name)?;
        let workspace = self.path(name)?;
        let mut record = workspace_record(&workspace, name)?;
        require_terminal(&record)?;
        record.insert("status".into(), json!("completed"));
        record.insert("handoff".into(), json!(handoff));
        record.insert("completed_at".into(), json!(lease::now()));
        self.publish(&workspace, record)?;
        lease::unreserve(base, &workspace, Duration::from_secs(60))?;
        Ok(())
    }

    pub(super) fn publish(&self, workspace: &Path, record: Map<String, Value>) -> Result<()> {
        let bytes = serde_json::to_vec(&record).map_err(std::io::Error::other)?;
        self.write(workspace, &bytes)
    }

    /// Check a completed workspace, or delete it while holding the janitor barriers.
    pub fn clean(&self, base: &LeaseBase, name: &str, apply: bool) -> Result<()> {
        let _operation = self.operation(name)?;
        let workspace = self.path(name)?;
        let record = workspace_record(&workspace, name)?;
        if record.get("status").and_then(Value::as_str) != Some("completed")
            || record
                .get("handoff")
                .and_then(Value::as_str)
                .is_none_or(|handoff| handoff.trim().is_empty())
        {
            return Err(WorkspaceError::Handoff);
        }
        let _janitor = apply
            .then(|| {
                lease::janitor(
                    &workspace,
                    Some(self.root()),
                    std::slice::from_ref(base),
                    None,
                )
            })
            .transpose()?;
        preserve_checkouts(&workspace)?;
        if apply {
            fs::remove_dir_all(&workspace)?;
        }
        Ok(())
    }

    /// Renew the reservations of unfinished workspaces, including uncertain runs.
    pub fn renew_all(&self, base: &LeaseBase) -> Result<BTreeMap<String, String>> {
        let mut result = BTreeMap::new();
        for entry in fs::read_dir(self.root())? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let name = entry.file_name();
            if let Some(name) = name.to_str().filter(|name| !name.starts_with('.')) {
                result.insert(name.to_owned(), self.renew_one(base, name));
            }
        }
        Ok(result)
    }

    fn renew_one(&self, base: &LeaseBase, name: &str) -> String {
        match self.renew_record(base, name) {
            Ok(status) => status.into(),
            Err(WorkspaceError::Busy(_)) => {
                "skipped: operation in progress (run() renews its own)".into()
            }
            Err(error) => format!("skipped: {error}"),
        }
    }

    fn renew_record(&self, base: &LeaseBase, name: &str) -> Result<&'static str> {
        let _operation = self.operation(name)?;
        let path = self.path(name)?;
        let record = workspace_record(&path, name)?;
        if record.get("status").and_then(Value::as_str) == Some("completed") {
            return Ok("skipped: completed");
        }
        match self.reserve(base, &path, true) {
            Ok(_) => Ok("renewed"),
            Err(WorkspaceError::Lease(error)) if error.code() == lease::LeaseCode::Unknown => {
                self.reserve(base, &path, false)?;
                Ok("reserved")
            }
            Err(error) => Err(error),
        }
    }
}

fn preserve_checkouts(workspace: &Path) -> Result<()> {
    let mut pending = vec![workspace.to_path_buf()];
    while let Some(path) = pending.pop() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            if entry.file_name() == ".git" {
                return Err(WorkspaceError::Checkout(entry.path()));
            }
            if entry.file_type()?.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Ok(())
}

pub(super) fn require_terminal(record: &Map<String, Value>) -> Result<()> {
    match record.get("status").and_then(Value::as_str) {
        Some("allocated" | "awaiting_handoff" | "failed") => Ok(()),
        _ => Err(WorkspaceError::Unsettled),
    }
}

pub(super) fn workspace_record(workspace: &Path, name: &str) -> Result<Map<String, Value>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(workspace.join(METADATA))?;
    if !file.metadata()?.is_file() {
        return Err(WorkspaceError::Record);
    }
    let record: Map<String, Value> =
        serde_json::from_reader(file).map_err(std::io::Error::other)?;
    if record.get("id").and_then(Value::as_str) != Some(name) {
        return Err(WorkspaceError::Record);
    }
    Ok(record)
}
