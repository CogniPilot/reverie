//! Thread census of one member cgroup against the process filesystem.
//!
//! `cgroup.threads` and `/proc/<tid>` are separate reads of a set that changes
//! while it is read: a member that compiles or loops over short commands ends
//! tasks every few milliseconds. A task that ended after it was listed is a
//! departure, not an identity violation, and it cannot be told apart from one
//! by its own files, because those are gone. The cgroup can tell: a departed
//! task is absent from the next listing. So every listed task must either be
//! inspected as a live task that names this cgroup, or be absent from a later
//! listing. A task that stays listed and cannot be inspected refuses the
//! census, as does a live task that names another cgroup, on first sight.
//!
//! The init process is not covered by that allowance. Its recorded identity is
//! what the scope stands on, so its exit always refuses.
use crate::{
    data,
    error::{Error, Result, need},
    files::Files,
};
use nix::{libc, sys::statfs::FsType};
use std::{collections::BTreeSet, time::Duration};

/// Pause before each fresh listing that follows a task which could not be
/// inspected. The kernel drops an exiting task from the listing before it
/// removes the task's files, so the first listing is normally enough; the
/// later ones bound how long a task may stay listed without being readable.
const RELISTING_PAUSES_MS: [u64; 5] = [0, 1, 2, 4, 8];

pub(super) struct Census<'a> {
    /// Directory holding one directory per task.
    pub(super) tasks: usize,
    pub(super) tasks_magic: FsType,
    pub(super) cgroup: usize,
    /// The cgroup path every member task must name.
    pub(super) path: &'a str,
    pub(super) init: u32,
    /// Whose cgroup this is, for failure reports.
    pub(super) subject: &'a str,
}
impl Census<'_> {
    pub(super) fn verify(&self, files: &mut Files) -> Result<()> {
        let mut pending = self.listed(files)?;
        let mut pauses = RELISTING_PAUSES_MS.into_iter();
        loop {
            let Some(unreadable) = self.inspect(files, &mut pending)? else {
                return Ok(());
            };
            let Some(pause) = pauses.next() else {
                return Err(unreadable);
            };
            std::thread::sleep(Duration::from_millis(pause));
            let listed = self.listed(files)?;
            pending.retain(|tid| listed.contains(tid));
        }
    }
    fn listed(&self, files: &mut Files) -> Result<BTreeSet<u32>> {
        pid_list(&files.read(self.cgroup, "cgroup.threads", 131072)?)
    }
    /// Leaves in `pending` only the tasks that could not be inspected because
    /// they no longer exist, and returns what the last of them reported.
    fn inspect(&self, files: &mut Files, pending: &mut BTreeSet<u32>) -> Result<Option<Error>> {
        let mut unreadable = None;
        for tid in std::mem::take(pending) {
            match self.member(files, tid) {
                Ok(()) => (),
                Err(error) if tid != self.init && departed(&error) => {
                    pending.insert(tid);
                    unreadable = Some(error);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(unreadable)
    }
    fn member(&self, files: &mut Files, tid: u32) -> Result<()> {
        let claimed = self.claim(files, tid);
        claimed.map_err(|error| error.of(|| format!("{} task {tid}", self.subject)))
    }
    fn claim(&self, files: &mut Files, tid: u32) -> Result<()> {
        let directory = files.child(self.tasks, &tid.to_string(), self.tasks_magic)?;
        let result = self.live_here(files, directory, tid);
        files.released(directory, result)
    }
    fn live_here(&self, files: &mut Files, directory: usize, tid: u32) -> Result<()> {
        need(
            files.read(directory, "cgroup", 4096)? == format!("0::{}\n", self.path),
            "BOXED_RESOURCE_FOREIGN_PID",
        )?;
        data::process_stat(&files.read(directory, "stat", 4096)?, tid).map(drop)
    }
}
/// Whether a failed inspection says only that the task no longer exists: its
/// directory or one of its files is gone, a read found no task behind an open
/// file, or its record shows it exited. Nothing else is an exit, and neither
/// is any failure that also lost a close.
pub(super) fn departed(error: &Error) -> bool {
    matches!(error, Error::Refused(code) if *code == data::PID_EXITED)
        || matches!(error.errno(), Some(libc::ENOENT | libc::ESRCH))
}
pub(super) fn pid_list(raw: &str) -> Result<BTreeSet<u32>> {
    let mut output = BTreeSet::new();
    for line in raw.lines() {
        let value = data::scalar(line)?
            .parse::<u32>()
            .map_err(|_| Error::Refused("BOXED_RESOURCE_PID_LIST"))?;
        need(value > 0 && output.insert(value), "BOXED_RESOURCE_PID_LIST")?;
    }
    need(output.len() <= 8192, "BOXED_RESOURCE_PID_BOUND")?;
    Ok(output)
}
