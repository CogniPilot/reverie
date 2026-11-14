use crate::{
    args::{Common, Member},
    data::{self, Resources},
    error::{Error, Result, need},
    files::Files,
};
use nix::sys::statfs::{CGROUP2_SUPER_MAGIC, PROC_SUPER_MAGIC};
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
}
pub(crate) struct Scope {
    pub(crate) common: Common,
    pub(crate) parent: usize,
    proc_root: usize,
    pub(crate) parent_path: String,
    pub(crate) processes: Vec<Process>,
}
impl Scope {
    pub(crate) fn capture(files: &mut Files, common: &Common) -> Result<Self> {
        need(
            nix::unistd::geteuid().is_root(),
            "BOXED_RESOURCE_ROOT_UID_REQUIRED",
        )?;
        need(common.member.len() <= 64, "BOXED_RESOURCE_MEMBER_BOUND")?;
        let proc_root = files.root("/proc", PROC_SUPER_MAGIC, true)?;
        let cg_root = files.root("/sys/fs/cgroup", CGROUP2_SUPER_MAGIC, true)?;
        let parent_path = format!(
            "/reverie.slice/reverie-box.slice/reverie-box-{}.slice",
            common.box_id
        );
        let mut parent = cg_root;
        for part in parent_path.trim_start_matches('/').split('/') {
            parent = files.child(parent, part, CGROUP2_SUPER_MAGIC)?;
        }
        let mut result = Self {
            common: common.clone(),
            parent,
            proc_root,
            parent_path,
            processes: vec![],
        };
        let anchor = Member {
            id: common.anchor_id.clone(),
            pid: common.anchor_pid,
            start: common.anchor_start.unwrap_or(0),
        };
        result
            .processes
            .push(result.capture_process(files, &anchor)?);
        let mut ids = BTreeSet::from([anchor.id]);
        let mut pids = BTreeSet::from([anchor.pid]);
        for member in &common.member {
            need(
                ids.insert(member.id.clone()) && pids.insert(member.pid),
                "BOXED_RESOURCE_DUPLICATE_MEMBER",
            )?;
            result
                .processes
                .push(result.capture_process(files, member)?);
        }
        result.assert_current(files)?;
        Ok(result)
    }
    fn capture_process(&self, files: &mut Files, member: &Member) -> Result<Process> {
        let name = format!("docker-{}.scope", member.id);
        let path = format!("{}/{name}", self.parent_path);
        let cgroup = files.child(self.parent, &name, CGROUP2_SUPER_MAGIC)?;
        let directory = files.child(self.proc_root, &member.pid.to_string(), PROC_SUPER_MAGIC)?;
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
        let named = files.child(
            self.proc_root,
            &process.identity.pid.to_string(),
            PROC_SUPER_MAGIC,
        )?;
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
        for pid in pid_list(&files.read(process.cgroup, "cgroup.threads", 131072)?)? {
            let directory = files.child(self.proc_root, &pid.to_string(), PROC_SUPER_MAGIC)?;
            need(
                files.read(directory, "cgroup", 4096)? == format!("0::{}\n", process.identity.path),
                "BOXED_RESOURCE_FOREIGN_PID",
            )?;
            data::process_stat(&files.read(directory, "stat", 4096)?, pid)?;
            files.release(directory)?;
        }
        Ok(())
    }
    pub(crate) fn worker(&self, id: &str) -> Result<usize> {
        self.processes
            .iter()
            .find(|p| p.identity.id == id)
            .map(|p| p.cgroup)
            .ok_or(Error::Refused("BOXED_RESOURCE_UNREGISTERED_WORKER"))
    }
}
fn pid_list(raw: &str) -> Result<BTreeSet<u32>> {
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
