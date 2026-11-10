//! Native observations for proposed DATA. No enrollment authentication,
//! administration, controller, budget or launch authority is minted here.
use super::*;
use crate::{
    engine_metadata::{EngineQuery, MetadataQueryOwner},
    resource_facts::InstalledFactsObserver,
    worker_pool::directory,
    worker_runtime::WorkerStopBudget,
};
use reverie_contracts::{
    resource_actor::{EngineMetadata, InstalledFactsDocument, PoolImageRole},
    resource_config::ResourceIdentitySettings,
    worker_pool::{WorkerPoolPolicy, validate_engine_information},
};
use reverie_store::storage_identity::{self, StorageIdentityConfig};
use std::collections::BTreeSet;
mod images;
mod prepared_policy;
mod revision;

pub(super) struct NominationDerivation {
    facts: InstalledFactsObserver,
    document: Option<InstalledFactsDocument>,
    company_reader: Option<PrivateBatch>,
    company_path: Option<PathBuf>,
    company_stamp: Option<native::PrivateFileStamp>,
    company: Option<reverie_contracts::storage_identity::Metadata>,
    cpu: Option<File>,
    cpu_identity: Option<native::private_goal::PathIdentity>,
    cpus: Option<Vec<u32>>,
    reader: MetadataQueryOwner,
    stop: WorkerStopBudget,
    raw: Vec<String>,
    raw_bytes: usize,
    last: Option<String>,
    end: Instant,
    prepared: prepared_policy::PreparedPolicyObservation,
}
impl NominationDerivation {
    pub(super) fn capture(runtime: &WorkerRuntime, end: Instant) -> Self {
        Self {
            facts: Default::default(),
            document: None,
            company_reader: None,
            company_path: None,
            company_stamp: None,
            company: None,
            cpu: None,
            cpu_identity: None,
            cpus: None,
            reader: runtime.readonly().capture_query_owner(),
            stop: runtime.stop_budget(),
            raw: Vec::new(),
            raw_bytes: 0,
            last: None,
            end,
            prepared: Default::default(),
        }
    }
    pub(super) fn derive(
        &mut self,
        runtime: &WorkerRuntime,
        config: &ReservationConfiguration,
        inputs: &PoolImageInputsData,
        enrollment: &[u8],
        root: &Path,
    ) -> Result<(PoolInstallationRequestData, Vec<String>)> {
        need(
            self.stop.same_runtime(runtime),
            "POOL_NOMINATION_RUNTIME_CHANGED",
        )?;
        self.document = Some(
            self.facts
                .observe(config.configuration(), self.deadline())?,
        );
        let settings = ResourceIdentitySettings::capture_worker_config(config.configuration())?;
        self.company_path =
            Some(PathBuf::from(settings.company_file().scalar_text().ok_or(
                PoolNominationError::Refused("POOL_NOMINATION_COMPANY_PATH"),
            )?));
        let company_path = self
            .company_path
            .as_ref()
            .expect("selected original company");
        self.company_reader = Some(PrivateBatch::new()?);
        self.company_reader
            .as_mut()
            .expect("retained company reader")
            .inspect(company_path, false, false)?;
        self.company_stamp = Some(native::PrivateFileStamp::of(&fs::symlink_metadata(
            company_path,
        )?));
        self.company = Some(storage_identity::read_company_metadata(
            &StorageIdentityConfig::capture_worker_settings(&settings),
        )?);
        let (highs, fallbacks) = PoolInstallationRequestData::proposed_employee_highs(
            config.configuration(),
            self.company.as_ref().expect("stored original company"),
        )?;
        let cpus = self.observe_cpus()?;
        let doc = self.document.as_ref().expect("original installed facts");
        let mut policy = WorkerPoolPolicy {
            version: 1,
            purpose: reverie_contracts::worker_pool::PURPOSE.into(),
            deployment: config.deployment()?,
            instance_root: root
                .to_str()
                .ok_or(PoolNominationError::Refused("POOL_NOMINATION_INSTANCE"))?
                .to_owned(),
            engine_id: doc.engine.id.clone(),
            website_container: doc.website.container.as_str().to_owned(),
            broker_uid: runtime.worker_identity().ids().uid(),
            broker_gid: runtime.worker_identity().ids().gid(),
            anchor_image: format!(
                "sha256:{}",
                inputs.archive_config_digest(PoolImageRole::Anchor).as_str()
            ),
            controller_image: format!(
                "sha256:{}",
                inputs
                    .archive_config_digest(PoolImageRole::Controller)
                    .as_str()
            ),
            memory_max_mi_b: reverie_contracts::worker_pool::MEMORY_MAX_MIB,
            pool_tasks_max: reverie_contracts::worker_pool::TASKS_MAX,
            cpu_weight: 100,
            allowed_cpus: cpus,
            employee_memory_high_mi_b: highs,
        };
        let info = self.query(runtime, EngineQuery::WorkerPoolInformation)?;
        validate_engine_information(info.as_bytes(), &policy)
            .map_err(|_| PoolNominationError::Refused("POOL_NOMINATION_DAEMON_CHANGED"))?;
        let site = self
            .document
            .as_ref()
            .expect("original installed facts")
            .website
            .container
            .clone();
        let raw = self.query(runtime, EngineQuery::WorkerPoolWebsiteInspect(&site))?;
        EngineMetadata::decode(raw.as_bytes())?.qualify_website(
            &self
                .document
                .as_ref()
                .expect("original installed facts")
                .website,
        )?;
        let [anchor, controller] = self.find_images(runtime, inputs)?;
        policy.anchor_image = anchor;
        policy.controller_image = controller;
        let request = PoolInstallationRequestData::from_enrollment(enrollment, &policy)?;
        self.assert_metadata(config)?;
        need(
            self.observe_cpus()? == policy.allowed_cpus,
            "POOL_NOMINATION_CPUS_CHANGED",
        )?;
        Ok((request, fallbacks))
    }
    pub(super) fn query(
        &mut self,
        runtime: &WorkerRuntime,
        query: EngineQuery<'_>,
    ) -> Result<String> {
        self.last = Some(
            self.reader
                .query(query, self.deadline(), &runtime.cancellation())?,
        );
        let raw = self.last.as_ref().expect("stored actual query result");
        self.raw_bytes = self
            .raw_bytes
            .checked_add(raw.len())
            .ok_or(PoolNominationError::Refused("POOL_NOMINATION_IMAGE_BOUND"))?;
        need(
            self.raw_bytes <= 16 * 1024 * 1024,
            "POOL_NOMINATION_IMAGE_BOUND",
        )?;
        self.raw
            .push(self.last.take().expect("same original query bytes"));
        Ok(self.raw.last().expect("retained query bytes").clone())
    }
    fn deadline(&self) -> Instant {
        self.stop
            .deadline()
            .map_or(self.end, |stop| self.end.min(stop))
    }
    fn observe_cpus(&mut self) -> Result<Vec<u32>> {
        if self.cpu.is_none() {
            self.cpu = Some(native::open_at(
                libc::AT_FDCWD,
                std::ffi::OsStr::new("/sys/fs/cgroup"),
                libc::O_RDONLY | libc::O_DIRECTORY,
            )?);
            self.cpu_identity = Some(native::private_goal::identity(
                &self
                    .cpu
                    .as_ref()
                    .expect("retained kernel root")
                    .metadata()?,
            ));
        }
        let file = self.cpu.as_ref().expect("same retained kernel root");
        let system = nix::sys::statfs::fstatfs(file)
            .map_err(|e| std::io::Error::from_raw_os_error(e as i32))?;
        need(
            system.filesystem_type() == nix::sys::statfs::CGROUP2_SUPER_MAGIC,
            "POOL_NOMINATION_CGROUP2_REQUIRED",
        )?;
        let cpus =
            directory::parse_cpus(directory::read_at(file, "cpuset.cpus.effective")?.trim())?;
        need(!cpus.is_empty(), "POOL_NOMINATION_CPUS_REQUIRED")?;
        if let Some(original) = &self.cpus {
            need(original == &cpus, "POOL_NOMINATION_CPUS_CHANGED")?;
        } else {
            self.cpus = Some(cpus.clone());
        }
        Ok(cpus)
    }
    pub(super) fn assert_metadata(&self, config: &ReservationConfiguration) -> Result<()> {
        self.prepared.assert_current()?;
        need(Instant::now() < self.deadline(), "POOL_NOMINATION_DEADLINE")?;
        self.facts
            .assert_metadata(config.configuration(), self.deadline())?;
        self.company_reader
            .as_ref()
            .expect("original company reader")
            .check()?;
        let path = self.company_path.as_ref().expect("original company");
        need(
            self.company_stamp.as_ref()
                == Some(&native::PrivateFileStamp::of(&fs::symlink_metadata(path)?)),
            "POOL_NOMINATION_COMPANY_CHANGED",
        )?;
        need(
            self.cpu_identity
                == Some(native::private_goal::identity(&fs::symlink_metadata(
                    "/sys/fs/cgroup",
                )?)),
            "POOL_NOMINATION_CPU_ROOT_CHANGED",
        )
    }
    pub(super) fn close(&mut self) -> Result<()> {
        let query = self
            .reader
            .settle_owned(self.deadline())
            .map_err(Into::into);
        let cpu = self
            .cpu
            .take()
            .map_or(Ok(()), |file| native::close(file).map_err(Into::into));
        let company = self
            .company_reader
            .as_mut()
            .map_or(Ok(()), |files| files.close().map_err(Into::into));
        let facts = self.facts.assert_finalized().map_err(Into::into);
        let prepared = self.prepared.close();
        finalized(
            finalized(query, cpu),
            finalized(finalized(company, facts), prepared),
        )
    }
}
