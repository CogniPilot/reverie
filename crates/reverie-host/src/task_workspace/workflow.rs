//! Lifecycle operations over the existing workspace and reservation formats.
use super::{METADATA, Result, TaskWorkspaces, WorkspaceError};
use crate::lease::{self, LeaseBase};
use serde_json::{Map, Value, json};
use std::{
    fs::{DirBuilder, OpenOptions},
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
            json!({"id": name, "status": "allocated", "created_at": lease::now()}),
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
        if !matches!(
            record.get("status").and_then(Value::as_str),
            Some("allocated" | "awaiting_handoff" | "failed")
        ) {
            return Err(WorkspaceError::Unsettled);
        }
        record.insert("status".into(), json!("completed"));
        record.insert("handoff".into(), json!(handoff));
        record.insert("completed_at".into(), json!(lease::now()));
        self.publish(&workspace, Value::Object(record))?;
        lease::unreserve(base, &workspace, Duration::from_secs(60))?;
        Ok(())
    }

    fn publish(&self, workspace: &Path, record: Value) -> Result<()> {
        let bytes = serde_json::to_vec(&record).map_err(std::io::Error::other)?;
        self.write(workspace, &bytes)
    }
}

fn workspace_record(workspace: &Path, name: &str) -> Result<Map<String, Value>> {
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
