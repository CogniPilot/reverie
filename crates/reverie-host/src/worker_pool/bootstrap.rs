//! Trusted native bootstrap's ORIGINAL broker binding. Origin only: no owner
//! consent, host-administration registration, maintenance or pool-write grant.
use super::*;
use crate::{
    installed_worker_engine::InstalledWorkerEngine,
    native,
    website_facts::{ImmutableInputObserver, ProcessSnapshot, WebsiteProcessObserver},
    worker_runtime::{WorkerRuntime, WorkerStopBudget},
};
use reverie_contracts::worker_pool::{BrokerBirthData, BrokerProgramData, ControllerBirthV2};
use std::{
    fs::File,
    os::{
        fd::OwnedFd,
        unix::{fs::MetadataExt, net::UnixStream},
    },
    path::Path,
    sync::Arc,
    time::Instant,
};

/// Populated only by the native broker package. Runtime environment variables,
/// wire paths and alternate executable selection are deliberately unavailable.
const PROGRAM: Option<&str> = option_env!("REVERIE_FIXED_NATIVE_WORKER_BROKER_MANIFEST");
mod arguments;
#[cfg(test)]
mod tests;

pub(super) fn assert_predecessor_source(birth: &ControllerBirthV2, source: &Path) -> Result<()> {
    use arguments::Role;
    let executable = native::python_path(birth.program().code().path.codepoints())?;
    let actual = birth.broker().argv_digest();
    need(
        Role::Broker.source_digest(&executable, source)? == actual
            || Role::InstallationOfferV1.source_digest(&executable, source)? == actual,
        "WORKER_POOL_PREDECESSOR_SOURCE_ARGUMENTS",
    )
}

#[must_use = "retain the actual binding through controller bootstrap and uncertainty"]
pub struct BrokerBootstrapBinding {
    role: arguments::Role,
    pub(super) engine: Arc<InstalledWorkerEngine>,
    pub(super) stop: WorkerStopBudget,
    manifest: Option<File>,
    pair: [Option<UnixStream>; 2],
    pidfd: Option<OwnedFd>,
    program: Option<BrokerProgramData>,
    process: Option<ProcessSnapshot>,
    code: ImmutableInputObserver,
    processes: WebsiteProcessObserver,
    closed: bool,
    close_unknown: bool,
}
impl WorkerRuntime {
    pub fn retain_pool_controller_bootstrap(
        &self,
        end: Instant,
    ) -> std::result::Result<BrokerBootstrapBinding, Box<BrokerBootstrapFailure>> {
        self.retain_pool_bootstrap(end, arguments::Role::Broker)
    }
    /// Distinct explicit installation-offer origin. This cannot adopt an
    /// ordinary service process: its original argv must select the versioned
    /// offer role. Origin observation still grants no administration authority.
    pub fn retain_pool_installation_offer_bootstrap(
        &self,
        source: &Path,
        end: Instant,
    ) -> std::result::Result<BrokerBootstrapBinding, Box<BrokerBootstrapFailure>> {
        let mut owner = self.retain_pool_bootstrap(end, arguments::Role::InstallationOfferV1)?;
        match owner.assert_registered_source(self, source, end) {
            Ok(()) => Ok(owner),
            Err(primary) => Err(Box::new(BrokerBootstrapFailure { owner, primary })),
        }
    }
    fn retain_pool_bootstrap(
        &self,
        end: Instant,
        role: arguments::Role,
    ) -> std::result::Result<BrokerBootstrapBinding, Box<BrokerBootstrapFailure>> {
        let mut owner = BrokerBootstrapBinding::for_role(self, role);
        match owner.capture(self, end, PROGRAM) {
            Ok(()) => Ok(owner),
            Err(primary) => Err(Box::new(BrokerBootstrapFailure { owner, primary })),
        }
    }
}
impl BrokerBootstrapBinding {
    #[cfg(test)]
    fn unopened(runtime: &WorkerRuntime) -> Self {
        Self::for_role(runtime, arguments::Role::Broker)
    }
    fn for_role(runtime: &WorkerRuntime, role: arguments::Role) -> Self {
        Self {
            role,
            engine: runtime.installed_engine().clone(),
            stop: runtime.stop_budget(),
            manifest: None,
            pair: [None, None],
            pidfd: None,
            program: None,
            process: None,
            code: ImmutableInputObserver::default(),
            processes: WebsiteProcessObserver::default(),
            closed: false,
            close_unknown: false,
        }
    }
    fn capture(
        &mut self,
        runtime: &WorkerRuntime,
        end: Instant,
        selected: Option<&str>,
    ) -> Result<()> {
        self.budget(end)?;
        let ids = runtime.worker_identity().ids();
        need(
            ids.uid() == native::uid() && ids.gid() == nix::unistd::getgid().as_raw(),
            "WORKER_POOL_NATIVE_BROKER_IDS",
        )?;
        let selected =
            selected.ok_or(PoolError::Refused("WORKER_POOL_NATIVE_BROKER_NOT_PACKAGED"))?;
        self.pin_self()?;
        self.open_program_manifest(Path::new(selected))?;
        self.program = Some(read_program(
            self.manifest.as_ref().expect("retained manifest"),
        )?);
        let end = self.budget(end)?;
        let observed = self
            .processes
            .observe_current_broker(end)
            .map_err(facts_error)?;
        let program = self.program.as_ref().expect("actual decoded native origin");
        let end = self.budget(end)?;
        let native = self
            .code
            .observe_broker_program(program, end)
            .map_err(facts_error)?;
        need(
            native.identity() == observed.executable(),
            "WORKER_POOL_NATIVE_BROKER_EXECUTABLE",
        )?;
        let end = self.budget(end)?;
        need(
            self.processes
                .observe_current_broker(end)
                .map_err(facts_error)?
                == observed,
            "WORKER_POOL_NATIVE_BROKER_CHANGED",
        )?;
        self.process = Some(observed);
        self.close_pair()?;
        self.assert_current(runtime, end)
    }
    fn open_program_manifest(&mut self, path: &Path) -> Result<()> {
        need(
            path.starts_with("/nix/store") && path.is_absolute(),
            "WORKER_POOL_BROKER_MANIFEST_SELECTION",
        )?;
        need(
            std::fs::canonicalize(path)? == path,
            "WORKER_POOL_BROKER_MANIFEST_SELECTION",
        )?;
        self.manifest = Some(native::open_at(
            libc::AT_FDCWD,
            path.as_os_str(),
            libc::O_RDONLY | libc::O_NONBLOCK,
        )?);
        Ok(())
    }
    fn pin_self(&mut self) -> Result<()> {
        // SO_PEERPIDFD on a newly owned self socketpair pins its actual creator.
        // No raw PID lookup, fallback or additional unsafe syscall is needed.
        let (first, second) = UnixStream::pair()?;
        self.pair = [Some(first), Some(second)];
        let socket = self.pair[0].as_ref().expect("owned pair");
        let peer = nix::sys::socket::getsockopt(socket, nix::sys::socket::sockopt::PeerCredentials)
            .map_err(io::Error::from)?;
        need(
            peer.pid() as u32 == std::process::id()
                && peer.uid() == native::uid()
                && peer.gid() == nix::unistd::getgid().as_raw(),
            "WORKER_POOL_BROKER_SELF_PEER",
        )?;
        self.pidfd = Some(
            nix::sys::socket::getsockopt(socket, nix::sys::socket::sockopt::PeerPidfd)
                .map_err(io::Error::from)?,
        );
        self.pidfd_live()
    }
    fn pidfd_live(&self) -> Result<()> {
        use std::os::fd::AsFd;
        let pidfd = self
            .pidfd
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_BROKER_PIDFD_UNKNOWN"))?;
        let mut ready = [nix::poll::PollFd::new(
            pidfd.as_fd(),
            nix::poll::PollFlags::POLLIN,
        )];
        need(
            nix::poll::poll(&mut ready, nix::poll::PollTimeout::ZERO).map_err(io::Error::from)?
                == 0,
            "WORKER_POOL_BROKER_ENDED",
        )
    }
    fn budget(&self, end: Instant) -> Result<Instant> {
        need(
            !self.closed && !self.close_unknown,
            "WORKER_POOL_BROKER_BINDING_CLOSED",
        )?;
        self.code.assert_finalized().map_err(facts_error)?;
        self.processes.assert_finalized().map_err(facts_error)?;
        let end = self.stop.deadline().map_or(end, |stop| end.min(stop));
        need(Instant::now() < end, "WORKER_POOL_BROKER_BINDING_DEADLINE")?;
        Ok(end)
    }
    pub fn assert_current(&mut self, runtime: &WorkerRuntime, end: Instant) -> Result<()> {
        self.assert_runtime(runtime, end)?;
        self.assert_original_current(end)
    }
    fn assert_runtime(&self, runtime: &WorkerRuntime, end: Instant) -> Result<()> {
        self.budget(end)?;
        need(
            Arc::ptr_eq(&self.engine, runtime.installed_engine()),
            "WORKER_POOL_BROKER_RUNTIME_CHANGED",
        )?;
        let ids = runtime.worker_identity().ids();
        need(
            ids.uid() == native::uid() && ids.gid() == nix::unistd::getgid().as_raw(),
            "WORKER_POOL_NATIVE_BROKER_IDS",
        )?;
        Ok(())
    }
    /// Reobserve only the original captured native owner. Callers must check
    /// their same-runtime/read-client provenance before using this private tail.
    pub(super) fn assert_original_current(&mut self, end: Instant) -> Result<()> {
        let end = self.assert_original_prefix(end)?;
        let current = self
            .processes
            .observe_current_broker(end)
            .map_err(facts_error)?;
        self.finish_process_current(&current, &self.processes)
    }
    /// Read-only status uses its original Q's observer, retaining any new
    /// descriptor uncertainty there rather than poisoning the installed owner.
    pub(super) fn assert_current_with_process_observer(
        &self,
        runtime: &WorkerRuntime,
        processes: &mut WebsiteProcessObserver,
        end: Instant,
    ) -> Result<()> {
        self.assert_runtime(runtime, end)?;
        let end = self.assert_original_prefix(end)?;
        let current = processes.observe_current_broker(end).map_err(facts_error)?;
        self.finish_process_current(&current, processes)
    }
    fn assert_original_prefix(&self, end: Instant) -> Result<Instant> {
        self.budget(end)?;
        self.pidfd_live()?;
        let program = self
            .program
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_BROKER_NOT_QUALIFIED"))?;
        need(
            read_program(
                self.manifest
                    .as_ref()
                    .ok_or(PoolError::Refused("WORKER_POOL_BROKER_BINDING_CLOSED"))?,
            )? == *program,
            "WORKER_POOL_BROKER_MANIFEST_CHANGED",
        )?;
        self.budget(end)
    }
    fn finish_process_current(
        &self,
        current: &ProcessSnapshot,
        processes: &WebsiteProcessObserver,
    ) -> Result<()> {
        need(
            self.process.as_ref() == Some(current),
            "WORKER_POOL_BROKER_PROCESS_CHANGED",
        )?;
        self.code.assert_finalized().map_err(facts_error)?;
        processes.assert_finalized().map_err(facts_error)?;
        self.pidfd_live()
    }
    /// Observation DATA for the separately checked immutable birth publication.
    /// The original nonclone owner/PIDFD remain here; no serde conversion can
    /// reconstruct them or grant registration, maintenance or activation.
    pub fn birth_document_data(
        &mut self,
        runtime: &WorkerRuntime,
        policy: WorkerPoolPolicy,
        end: Instant,
    ) -> Result<ControllerBirthV2> {
        self.assert_current(runtime, end)?;
        need(
            policy.deployment == runtime.worker_identity().deployment(),
            "WORKER_POOL_BROKER_DEPLOYMENT_CHANGED",
        )?;
        let process = self.process.as_ref().expect("qualified actual self");
        let ids = runtime.worker_identity().ids();
        let broker = BrokerBirthData::from_observations(
            std::process::id(),
            process.start().as_str().into(),
            [ids.uid(), ids.gid()],
            process.executable(),
            process.namespaces(),
            process.argv_digest().as_str().into(),
        )
        .map_err(|_| PoolError::Refused("WORKER_POOL_BROKER_BIRTH_DATA"))?;
        ControllerBirthV2::from_observations(
            policy,
            broker,
            self.program.as_ref().expect("qualified program").clone(),
        )
        .map_err(|_| PoolError::Refused("WORKER_POOL_BROKER_BIRTH_DATA"))
    }
    /// Compare the actual loader-selected source with this fixed native role's
    /// raw argv. This opens no caller path and sets no authorization flag.
    pub fn assert_registered_source(
        &mut self,
        runtime: &WorkerRuntime,
        source: &Path,
        end: Instant,
    ) -> Result<()> {
        self.assert_current(runtime, end)?;
        let program = self.program.as_ref().expect("qualified actual origin");
        let executable = native::python_path(program.code().path.codepoints())?;
        need(
            self.role.source_digest(&executable, source)?
                == self
                    .process
                    .as_ref()
                    .expect("qualified actual process")
                    .argv_digest()
                    .as_str(),
            "WORKER_POOL_BROKER_REGISTERED_ARGUMENTS",
        )
    }
    fn close_pair(&mut self) -> Result<()> {
        let first = close_stream(&mut self.pair[0]);
        let second = close_stream(&mut self.pair[1]);
        let body = finalized(first, second);
        self.close_unknown |= body.is_err();
        body
    }
    /// Only metadata/pidfd finalization. It does not stop or collect the broker,
    /// invalidate a controller process, or finish any resource operation.
    pub fn close(&mut self) -> Result<()> {
        self.closed = true;
        let pair = self.close_pair();
        let manifest = self
            .manifest
            .take()
            .map(native::close)
            .transpose()
            .map(|_| ())
            .map_err(Into::into);
        let pidfd = self
            .pidfd
            .take()
            .map(|fd| native::close(File::from(fd)))
            .transpose()
            .map(|_| ())
            .map_err(Into::into);
        let body = finalized(finalized(pair, manifest), pidfd);
        self.close_unknown |= body.is_err();
        body?;
        self.code.assert_finalized().map_err(facts_error)?;
        self.processes.assert_finalized().map_err(facts_error)?;
        need(
            !self.close_unknown,
            "WORKER_POOL_BROKER_BINDING_CLOSE_UNKNOWN",
        )
    }
}
impl Drop for BrokerBootstrapBinding {
    fn drop(&mut self) {
        std::mem::forget(self.manifest.take());
        std::mem::forget(self.pidfd.take());
        for socket in &mut self.pair {
            std::mem::forget(socket.take());
        }
    }
}
pub struct BrokerBootstrapFailure {
    owner: BrokerBootstrapBinding,
    primary: PoolError,
}
impl BrokerBootstrapFailure {
    pub fn primary_error(&self) -> &PoolError {
        &self.primary
    }
    pub fn close(&mut self) -> Result<()> {
        self.owner.close()
    }
}
fn close_stream(stream: &mut Option<UnixStream>) -> Result<()> {
    stream
        .take()
        .map(|stream| native::close(File::from(OwnedFd::from(stream))))
        .transpose()
        .map(|_| ())
        .map_err(Into::into)
}
fn read_program(file: &File) -> Result<BrokerProgramData> {
    use std::os::unix::fs::FileExt;
    let before = file.metadata()?;
    need(
        before.is_file()
            && before.uid() == 0
            && before.mode() & 0o222 == 0
            && (1..=8192).contains(&before.len()),
        "WORKER_POOL_BROKER_MANIFEST_CUSTODY",
    )?;
    let mut raw = [0; 8193];
    let count = file.read_at(&mut raw, 0)?;
    let after = file.metadata()?;
    need(
        count as u64 == before.len()
            && [before.dev(), before.ino(), before.len()]
                == [after.dev(), after.ino(), after.len()]
            && before.mtime_nsec() == after.mtime_nsec()
            && before.ctime_nsec() == after.ctime_nsec()
            && before.mtime() == after.mtime()
            && before.ctime() == after.ctime(),
        "WORKER_POOL_BROKER_MANIFEST_CHANGED",
    )?;
    BrokerProgramData::decode(&raw[..count])
        .map_err(|_| PoolError::Refused("WORKER_POOL_BROKER_MANIFEST_INVALID"))
}
fn facts_error(error: crate::website_facts::WebsiteFactsError) -> PoolError {
    PoolError::BootstrapFacts(Box::new(error))
}
