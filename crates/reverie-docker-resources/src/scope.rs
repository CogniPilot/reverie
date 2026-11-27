mod census;

use crate::{
    args::{Common, Member},
    data::{self, Resources},
    error::{Error, Result, need},
    files::Files,
};
use census::{Census, pid_list};
use nix::sys::statfs::{CGROUP2_SUPER_MAGIC, FsType, PROC_SUPER_MAGIC};
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Identity {
    pub(crate) id: String,
    pub(crate) pid: u32,
    pub(crate) start_ticks: String,
    pub(crate) path: String,
    pub(crate) dev: String,
    pub(crate) ino: String,
}
pub(crate) struct Process {
    pub(crate) identity: Identity,
    directory: usize,
    cgroup: usize,
    /// Role and container, for failure reports: `anchor`, `worker` or `member`.
    subject: String,
}
/// The kernel views a scope is read through, besides its box cgroup: the
/// cgroup filesystem type and the process filesystem. [`Scope::capture`] alone
/// supplies the native ones.
struct Views {
    cgroup_magic: FsType,
    tasks: usize,
    tasks_magic: FsType,
}
pub(crate) struct Scope {
    pub(crate) common: Common,
    pub(crate) parent: usize,
    views: Views,
    pub(crate) parent_path: String,
    pub(crate) processes: Vec<Process>,
}
/// Failure-report name of the box cgroup and the path leading to it.
const BOX: &str = "box";
impl Scope {
    /// `worker` names the member a leaf operation targets, for failure reports.
    pub(crate) fn capture(
        files: &mut Files,
        common: &Common,
        worker: Option<&str>,
    ) -> Result<Self> {
        need(
            nix::unistd::geteuid().is_root(),
            "BOXED_RESOURCE_ROOT_UID_REQUIRED",
        )?;
        need(common.member.len() <= 64, "BOXED_RESOURCE_MEMBER_BOUND")?;
        let tasks = files.root("/proc", PROC_SUPER_MAGIC, true)?;
        let parent = enter(files, common).map_err(|error| error.of(|| BOX.to_owned()))?;
        let views = Views {
            cgroup_magic: CGROUP2_SUPER_MAGIC,
            tasks,
            tasks_magic: PROC_SUPER_MAGIC,
        };
        Self::bind(files, common, worker, parent, views)
    }
    fn bind(
        files: &mut Files,
        common: &Common,
        worker: Option<&str>,
        parent: usize,
        views: Views,
    ) -> Result<Self> {
        let mut result = Self {
            common: common.clone(),
            parent,
            views,
            parent_path: parent_path(common),
            processes: vec![],
        };
        let anchor = Member {
            id: common.anchor_id.clone(),
            pid: common.anchor_pid,
            start: common.anchor_start.unwrap_or(0),
        };
        result
            .processes
            .push(result.capture_process(files, &anchor, "anchor")?);
        let mut ids = BTreeSet::from([anchor.id]);
        let mut pids = BTreeSet::from([anchor.pid]);
        for member in &common.member {
            need(
                ids.insert(member.id.clone()) && pids.insert(member.pid),
                "BOXED_RESOURCE_DUPLICATE_MEMBER",
            )?;
            let role = if worker == Some(member.id.as_str()) {
                "worker"
            } else {
                "member"
            };
            result
                .processes
                .push(result.capture_process(files, member, role)?);
        }
        // Named only now: a member cgroup that fails to open is its member's.
        files.name(parent, BOX);
        result.assert_current(files)?;
        Ok(result)
    }
    fn capture_process(&self, files: &mut Files, member: &Member, role: &str) -> Result<Process> {
        let subject = format!("{role} {}", member.id);
        let pinned = self.pin(files, member, &subject);
        pinned.map_err(|error| error.of(|| subject))
    }
    fn pin(&self, files: &mut Files, member: &Member, subject: &str) -> Result<Process> {
        let name = format!("docker-{}.scope", member.id);
        let path = format!("{}/{name}", self.parent_path);
        let cgroup = files.child(self.parent, &name, self.views.cgroup_magic)?;
        files.name(cgroup, subject);
        let directory = files.child(
            self.views.tasks,
            &member.pid.to_string(),
            self.views.tasks_magic,
        )?;
        files.name(directory, subject);
        need(
            files.read(directory, "cgroup", 4096)? == format!("0::{path}\n"),
            "BOXED_RESOURCE_PID_CGROUP",
        )?;
        let start = data::process_stat(&files.read(directory, "stat", 4096)?, member.pid)?;
        need(
            member.start == 0 || member.start == start,
            "BOXED_RESOURCE_PID_CHANGED",
        )?;
        let (dev, ino) = files.identity(cgroup)?;
        Ok(Process {
            identity: Identity {
                id: member.id.clone(),
                pid: member.pid,
                start_ticks: start.to_string(),
                path,
                dev: dev.to_string(),
                ino: ino.to_string(),
            },
            directory,
            cgroup,
            subject: subject.to_owned(),
        })
    }
    pub(crate) fn assert_current(&self, files: &mut Files) -> Result<()> {
        need(
            files.read(self.parent, "cgroup.type", 128)? == "domain\n",
            "BOXED_RESOURCE_DOMAIN",
        )?;
        need(
            files.read(self.parent, "cgroup.procs", 131072)?.is_empty(),
            "BOXED_RESOURCE_PARENT_HAS_PROCESSES",
        )?;
        let mut expected = self
            .processes
            .iter()
            .map(|p| format!("docker-{}.scope", p.identity.id))
            .collect::<Vec<_>>();
        expected.sort();
        need(
            files.entries(self.parent)? == expected,
            "BOXED_RESOURCE_FOREIGN_CHILD",
        )?;
        for process in &self.processes {
            self.process_current(files, process)?;
            self.members_current(files, process)?;
        }
        Ok(())
    }
    /// The init process is pinned by its retained directory and recorded
    /// birth. Its exit or replacement always refuses.
    fn process_current(&self, files: &mut Files, process: &Process) -> Result<()> {
        need(
            data::process_stat(
                &files.read(process.directory, "stat", 4096)?,
                process.identity.pid,
            )?
            .to_string()
                == process.identity.start_ticks,
            "BOXED_RESOURCE_PID_CHANGED",
        )?;
        need(
            files.read(process.directory, "cgroup", 4096)?
                == format!("0::{}\n", process.identity.path),
            "BOXED_RESOURCE_PID_CGROUP",
        )?;
        let named = files
            .child(
                self.views.tasks,
                &process.identity.pid.to_string(),
                self.views.tasks_magic,
            )
            .map_err(|error| error.of(|| process.subject.clone()))?;
        need(
            files.identity(named)? == files.identity(process.directory)?,
            "BOXED_RESOURCE_PID_REPLACED",
        )?;
        files.release(named)
    }
    fn members_current(&self, files: &mut Files, process: &Process) -> Result<()> {
        need(
            files.read(process.cgroup, "cgroup.type", 128)? == "domain\n",
            "BOXED_RESOURCE_DOMAIN",
        )?;
        need(
            files.entries(process.cgroup)?.is_empty(),
            "BOXED_RESOURCE_NESTED_WORKER_CGROUP",
        )?;
        let procs = pid_list(&files.read(process.cgroup, "cgroup.procs", 131072)?)?;
        need(
            procs.contains(&process.identity.pid),
            "BOXED_RESOURCE_INIT_NOT_MEMBER",
        )?;
        Census {
            tasks: self.views.tasks,
            tasks_magic: self.views.tasks_magic,
            cgroup: process.cgroup,
            path: &process.identity.path,
            init: process.identity.pid,
            subject: &process.subject,
        }
        .verify(files)
    }
    pub(crate) fn worker(&self, id: &str) -> Result<usize> {
        self.processes
            .iter()
            .find(|p| p.identity.id == id)
            .map(|p| p.cgroup)
            .ok_or(Error::Refused("BOXED_RESOURCE_UNREGISTERED_WORKER"))
    }
}
fn enter(files: &mut Files, common: &Common) -> Result<usize> {
    let mut parent = files.root("/sys/fs/cgroup", CGROUP2_SUPER_MAGIC, true)?;
    for part in parent_path(common).trim_start_matches('/').split('/') {
        parent = files.child(parent, part, CGROUP2_SUPER_MAGIC)?;
    }
    Ok(parent)
}
fn parent_path(common: &Common) -> String {
    format!(
        "/reverie.slice/reverie-box.slice/reverie-box-{}.slice",
        common.box_id
    )
}
pub(crate) fn resources(files: &mut Files, index: usize) -> Result<Resources> {
    let mut scalar = |name| data::scalar(&files.read(index, name, 128)?);
    let memory_max = scalar("memory.max")?;
    let memory_high = scalar("memory.high")?;
    let swap_max = scalar("memory.swap.max")?;
    let pids_max = scalar("pids.max")?;
    let cpu_weight = scalar("cpu.weight")?;
    let cpu_max = data::cpu_max(&files.read(index, "cpu.max", 128)?)?;
    let cpuset_cpus = files
        .read(index, "cpuset.cpus", 4096)?
        .trim_end_matches('\n')
        .to_owned();
    data::cpus(&cpuset_cpus)?;
    let cpuset_cpus_effective = files
        .read(index, "cpuset.cpus.effective", 4096)?
        .trim_end_matches('\n')
        .to_owned();
    data::cpus(&cpuset_cpus_effective)?;
    let cpuset_mems_effective = files
        .read(index, "cpuset.mems.effective", 4096)?
        .trim_end_matches('\n')
        .to_owned();
    data::cpus(&cpuset_mems_effective)?;
    Ok(Resources {
        memory_max,
        memory_high,
        swap_max,
        pids_max,
        cpu_weight,
        cpu_max,
        cpuset_cpus,
        cpuset_cpus_effective,
        cpuset_mems_effective,
    })
}

#[cfg(test)]
mod tests;
