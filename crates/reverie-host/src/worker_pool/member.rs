//! Read-only pre-pane membership. This lower controller observation is not a
//! Created receipt, launch permission, provider fence or capacity release.
use super::{directory, *};
use crate::native;
use std::{ffi::OsStr, fs::File, os::fd::AsRawFd};

/// Expected policy DATA supplied by the owning application operation. It does
/// not authorize a write, choose a pathname or establish native enforcement.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PoolMemberLimits {
    cpu_weight: u32,
    tasks_max: u32,
}
impl PoolMemberLimits {
    pub fn try_new(cpu_weight: u32, tasks_max: u32) -> Result<Self> {
        need(
            (1..=10_000).contains(&cpu_weight) && (64..=4096).contains(&tasks_max),
            "WORKER_POOL_MEMBER_POLICY",
        )?;
        Ok(Self {
            cpu_weight,
            tasks_max,
        })
    }
}

#[derive(Eq, PartialEq)]
enum Stage {
    Opening,
    Configuring,
    Verified,
    Refused,
    Closing,
    Closed,
}

/// Retains the same leaf directory and borrows the actual installed parent.
/// Capture checks exactly one init process. Normal pane startup must use
/// the existing Created/start/memory owners and join this observation there;
/// CID/PID data cannot create any of those tokens.
pub struct OpenedPoolMember<'pool> {
    pool: InstalledWorkerPool<'pool>,
    directory: Option<File>,
    identity: (u64, u64),
    id: String,
    pid: u32,
    start: String,
    high: u64,
    limits: PoolMemberLimits,
    stage: Stage,
    close_unknown: bool,
}
impl<'pool> OpenedPoolMember<'pool> {
    pub fn capture(
        pool: &InstalledWorkerPool<'pool>,
        employee: &str,
        id: &str,
        pid: u32,
        limits: PoolMemberLimits,
    ) -> std::result::Result<Self, Box<PoolMemberFailure<'pool>>> {
        // Retain the partial owner before opening its first descriptor.
        let mut owner = Self {
            pool: pool.borrow_view(),
            directory: None,
            identity: (0, 0),
            id: id.into(),
            pid,
            start: String::new(),
            high: 0,
            limits,
            stage: Stage::Opening,
            close_unknown: false,
        };
        let result = owner.acquire(employee).and_then(|()| owner.observe());
        match result {
            Ok(()) => {
                owner.stage = Stage::Verified;
                Ok(owner)
            }
            Err(primary) => {
                owner.stage = Stage::Refused;
                owner.close_unknown |= primary.close_unknown();
                Err(Box::new(PoolMemberFailure { owner, primary }))
            }
        }
    }
    fn acquire(&mut self, employee: &str) -> Result<()> {
        self.pool.reobserve()?;
        need(
            reverie_contracts::worker_pool::hex_id(&self.id)
                && self.id != self.pool.anchor_id
                && self.pid > 1,
            "WORKER_POOL_MEMBER_IDENTITY",
        )?;
        let high = self
            .pool
            .policy_data()
            .employee_memory_high_mi_b
            .get(employee)
            .ok_or(PoolError::Refused("WORKER_POOL_MEMBER_EMPLOYEE"))?;
        need(
            *high > 0 && *high <= self.pool.policy_data().memory_max_mi_b,
            "WORKER_POOL_MEMBER_SOFT_THRESHOLD",
        )?;
        self.high = u64::from(*high) * 1_048_576;
        self.directory = Some(self.open_named()?);
        self.identity = directory::identity(self.file()?)?;
        self.start = directory::process_start(self.pid)?;
        self.assert_process()
    }
    /// Fixed native controller path only, after original broker authorization
    /// and global maintenance. Holds the same leaf FD before the first write.
    pub(super) fn configure_new(
        pool: &InstalledWorkerPool<'pool>,
        employee: &str,
        id: &str,
        pid: u32,
        limits: PoolMemberLimits,
        end: std::time::Instant,
    ) -> std::result::Result<Self, Box<PoolMemberFailure<'pool>>> {
        let mut owner = Self {
            pool: pool.borrow_view(),
            directory: None,
            identity: (0, 0),
            id: id.into(),
            pid,
            start: String::new(),
            high: 0,
            limits,
            stage: Stage::Opening,
            close_unknown: false,
        };
        let result = owner.acquire(employee).and_then(|()| owner.configure(end));
        match result {
            Ok(()) => {
                owner.stage = Stage::Verified;
                Ok(owner)
            }
            Err(primary) => {
                owner.stage = Stage::Refused;
                owner.close_unknown |= primary.close_unknown();
                Err(Box::new(PoolMemberFailure { owner, primary }))
            }
        }
    }
    fn configure(&mut self, end: std::time::Instant) -> Result<()> {
        self.pool.reobserve()?;
        for (name, expected) in [
            (
                "memory.max",
                (u64::from(self.pool.policy_data().memory_max_mi_b) * 1_048_576).to_string(),
            ),
            ("memory.swap.max", "0".into()),
            ("pids.max", self.limits.tasks_max.to_string()),
            ("cpu.max", "max 100000".into()),
        ] {
            need(
                directory::read_at(self.file()?, name)?.trim() == expected,
                "WORKER_POOL_MEMBER_HARD_LIMIT",
            )?;
        }
        let nodes = self
            .pool
            .directory
            .memory_nodes()
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        self.stage = Stage::Configuring;
        for (name, value) in [
            ("cpuset.mems", nodes),
            ("cpuset.cpus", self.pool.policy_data().cpu_list()),
            ("memory.high", self.high.to_string()),
            ("cpu.weight", self.limits.cpu_weight.to_string()),
        ] {
            self.assert_identity()?;
            need(
                std::time::Instant::now() < end,
                "WORKER_POOL_MEMBER_DEADLINE",
            )?;
            directory::write_at(self.file()?, name, value.as_bytes())?;
        }
        self.observe()?;
        need(
            std::time::Instant::now() < end,
            "WORKER_POOL_MEMBER_DEADLINE",
        )
    }
    fn file(&self) -> Result<&File> {
        self.directory
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_MEMBER_CLOSED"))
    }
    fn open_named(&self) -> Result<File> {
        Ok(native::open_at(
            self.pool.directory.parent()?.as_raw_fd(),
            OsStr::new(&format!("docker-{}.scope", self.id)),
            nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
        )?)
    }
    fn assert_process(&self) -> Result<()> {
        let expected = format!(
            "0::/{}/docker-{}.scope\n",
            self.pool.policy_data().parent_cgroup_relative(),
            self.id,
        );
        need(
            directory::bounded_path(&format!("/proc/{}/cgroup", self.pid), 4096)? == expected
                && directory::process_start(self.pid)? == self.start
                && directory::read_at(self.file()?, "cgroup.procs")? == format!("{}\n", self.pid),
            "WORKER_POOL_MEMBER_PROCESS_CHANGED",
        )
    }
    fn observe(&self) -> Result<()> {
        self.assert_identity()?;
        self.assert_limits()?;
        self.assert_process()?;
        self.pool.reobserve()
    }
    fn assert_identity(&self) -> Result<()> {
        self.pool.reobserve()?;
        self.assert_process()?;
        need(
            directory::identity(self.file()?)? == self.identity,
            "WORKER_POOL_MEMBER_DIRECTORY_CHANGED",
        )?;
        let named = self.open_named()?;
        let observed = (|| {
            need(
                directory::identity(&named)? == self.identity,
                "WORKER_POOL_MEMBER_DIRECTORY_REBOUND",
            )?;
            self.assert_process()?;
            self.pool.reobserve()
        })();
        finalized(observed, native::close(named).map_err(Into::into))
    }
    fn assert_limits(&self) -> Result<()> {
        let policy = self.pool.policy_data();
        for (name, expected) in [
            (
                "memory.max",
                (u64::from(policy.memory_max_mi_b) * 1_048_576).to_string(),
            ),
            ("memory.high", self.high.to_string()),
            ("memory.swap.max", "0".into()),
            ("pids.max", self.limits.tasks_max.to_string()),
            ("cpu.max", "max 100000".into()),
            ("cpu.weight", self.limits.cpu_weight.to_string()),
        ] {
            need(
                directory::read_at(self.file()?, name)?.trim() == expected,
                "WORKER_POOL_MEMBER_LIMIT_READBACK",
            )?;
        }
        for name in ["cpuset.cpus", "cpuset.cpus.effective"] {
            need(
                directory::parse_cpus(directory::read_at(self.file()?, name)?.trim())?
                    == policy.allowed_cpus,
                "WORKER_POOL_MEMBER_CPU_PLACEMENT",
            )?;
        }
        for name in ["cpuset.mems", "cpuset.mems.effective"] {
            need(
                directory::parse_cpus(directory::read_at(self.file()?, name)?.trim())?
                    == self.pool.directory.memory_nodes(),
                "WORKER_POOL_MEMBER_MEMORY_NODE_PLACEMENT",
            )?;
        }
        Ok(())
    }
    /// Any refusal terminally fences this observation. No retry or repair.
    pub fn reobserve(&mut self) -> Result<()> {
        need(
            self.stage == Stage::Verified,
            "WORKER_POOL_MEMBER_UNCONFIRMED",
        )?;
        let result = self.observe();
        if let Err(error) = &result {
            self.stage = Stage::Refused;
            self.close_unknown |= error.close_unknown();
        }
        result
    }
    pub fn kernel_identity(&self) -> Result<(u64, u64)> {
        need(
            self.stage == Stage::Verified,
            "WORKER_POOL_MEMBER_UNCONFIRMED",
        )?;
        Ok(self.identity)
    }
    /// Only closes this metadata owner. This stops no worker and releases no
    /// reservation, pool capacity or outer operation.
    pub fn close(&mut self) -> Result<()> {
        self.stage = Stage::Closing;
        let closed = self
            .directory
            .take()
            .map(native::close)
            .transpose()
            .map(|_| ())
            .map_err(PoolError::from);
        self.close_unknown |= closed.is_err();
        closed?;
        need(!self.close_unknown, "WORKER_POOL_MEMBER_CLOSE_UNKNOWN")?;
        self.stage = Stage::Closed;
        Ok(())
    }
}
impl Drop for OpenedPoolMember<'_> {
    fn drop(&mut self) {
        if self.stage != Stage::Closed {
            // Default descriptor destruction is not a checked finalization.
            std::mem::forget(self.directory.take());
        }
    }
}

/// Keeps the actual partial owner on every refusal, including unconfirmed
/// metadata close. No error-only conversion discards the original handle.
pub struct PoolMemberFailure<'pool> {
    owner: OpenedPoolMember<'pool>,
    primary: PoolError,
}
/// Remaining metadata custody after a failed member body. No forward
/// observation or capacity proof survives this consuming transition.
pub(super) struct MemberComponent {
    directory: Option<File>,
    close_unknown: bool,
    primary: PoolError,
}
impl MemberComponent {
    pub(super) fn close(&mut self) -> Result<()> {
        let result = self
            .directory
            .take()
            .map(native::close)
            .transpose()
            .map(|_| ())
            .map_err(PoolError::from);
        self.close_unknown |= result.is_err();
        result?;
        need(!self.close_unknown, "WORKER_POOL_MEMBER_CLOSE_UNKNOWN")
    }
    pub(super) fn cause(&self) -> &PoolError {
        &self.primary
    }
}
impl Drop for MemberComponent {
    fn drop(&mut self) {
        std::mem::forget(self.directory.take());
    }
}
impl OpenedPoolMember<'_> {
    pub(super) fn into_component(mut self, primary: PoolError) -> MemberComponent {
        MemberComponent {
            directory: self.directory.take(),
            close_unknown: self.close_unknown,
            primary,
        }
    }
}
impl PoolMemberFailure<'_> {
    pub fn primary_error(&self) -> &PoolError {
        &self.primary
    }
    pub fn close(&mut self) -> Result<()> {
        self.owner.close()
    }
    pub(super) fn into_component(self) -> MemberComponent {
        let Self { owner, primary } = self;
        owner.into_component(primary)
    }
}
