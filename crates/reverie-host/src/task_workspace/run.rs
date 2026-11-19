//! Protect a run until its verified outcome has been published.
use super::{
    OperationLock, Result, TaskWorkspaces, WorkspaceError,
    workflow::{require_terminal, workspace_record},
};
use crate::lease::{self, HeldLeases, LeaseBase, Signals, exit_status};
use nix::sys::signal::Signal;
use serde_json::{Map, Value, json};
use std::{
    fs::{self, DirBuilder},
    io,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

/// The final observation of a supervised command.
pub enum RunOutcome {
    /// The command's exit code, or the negative signal number if terminated.
    Exited(i32),
    /// A signal arrived before the command started.
    InterruptedBeforeLaunch(Signal),
    /// The complete cleanup could not be verified.
    CleanupUnknown,
}

/// The configured command and the live protection around it.
///
/// Dropping an unsettled run keeps its durable `running` record and reservation.
struct TaskRun<'a> {
    registry: &'a TaskWorkspaces,
    base: &'a LeaseBase,
    workspace: PathBuf,
    record: Map<String, Value>,
    _lease: HeldLeases,
    _operation: OperationLock,
}

impl TaskWorkspaces {
    /// Run a command under the workspace's operation lock and lease, and
    /// publish its outcome while both protections are still held.
    pub fn run(
        &self,
        base: &LeaseBase,
        name: &str,
        command: &mut Command,
        signals: &Signals,
    ) -> Result<RunOutcome> {
        let prepared = self.prepare_run(base, name, command, &|| signals.pending().is_some());
        let task = match (prepared, signals.pending()) {
            (Ok(task), Some(signal)) => return task.interrupted(signal),
            (Err(_), Some(signal)) => return Ok(RunOutcome::InterruptedBeforeLaunch(signal)),
            (result, None) => result?,
        };
        let mut child = match signals.spawn(command) {
            Ok(Some(child)) => child,
            Ok(None) => return task.interrupted(signals.pending().expect("recorded stop")),
            Err(error) => {
                task.settle(Some(127))?;
                return Err(error.into());
            }
        };
        let exit = child.wait().map(exit_status);
        let settled = if signals.close_group() {
            exit.ok()
        } else {
            None
        };
        task.settle(settled)?;
        Ok(settled.map_or(RunOutcome::CleanupUnknown, RunOutcome::Exited))
    }

    /// Acquire the operation lock and lease, configure scratch, then record
    /// the run before the caller may spawn the command.
    fn prepare_run<'a>(
        &'a self,
        base: &'a LeaseBase,
        name: &str,
        command: &mut Command,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<TaskRun<'a>> {
        let operation = self.operation(name)?;
        let workspace = self.path(name)?;
        let mut record = workspace_record(&workspace, name)?;
        require_terminal(&record)?;
        self.reserve(base, &workspace, true)?;
        configure(command, &workspace)?;
        let lease = lease::hold_cancellable(
            base,
            std::slice::from_ref(&workspace),
            Path::new(command.get_program()),
            Duration::from_secs(60),
            cancelled,
        )?;
        record.insert("status".into(), json!("running"));
        record.insert("started_at".into(), json!(lease::now()));
        self.publish(&workspace, record.clone())?;
        Ok(TaskRun {
            registry: self,
            base,
            workspace,
            record,
            _lease: lease,
            _operation: operation,
        })
    }
}

impl TaskRun<'_> {
    fn interrupted(self, signal: Signal) -> Result<RunOutcome> {
        self.settle(Some(-(signal as i32)))?;
        Ok(RunOutcome::InterruptedBeforeLaunch(signal))
    }

    fn settle(mut self, exit_code: Option<i32>) -> Result<()> {
        let status = match exit_code {
            Some(0) => "awaiting_handoff",
            Some(_) => "failed",
            None => "cleanup_unknown",
        };
        self.record.insert("status".into(), json!(status));
        self.record.insert("exit_code".into(), json!(exit_code));
        let published = self.registry.publish(&self.workspace, self.record);
        let renewed = self.registry.reserve(self.base, &self.workspace, true);
        published?;
        renewed?;
        Ok(())
    }
}

fn configure(command: &mut Command, workspace: &Path) -> Result<()> {
    let temporary = task_directory(workspace, "tmp")?;
    let target = task_directory(workspace, "build")?;
    command
        .current_dir(workspace)
        .env("TMPDIR", &temporary)
        .env("TMP", &temporary)
        .env("TEMP", temporary)
        .env("CARGO_TARGET_DIR", target);
    Ok(())
}

fn task_directory(workspace: &Path, name: &str) -> Result<PathBuf> {
    let path = workspace.join(name);
    match DirBuilder::new().mode(0o700).create(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if !fs::symlink_metadata(&path)?.is_dir() {
                return Err(WorkspaceError::Record);
            }
        }
        Err(error) => return Err(error.into()),
    }
    Ok(path)
}
