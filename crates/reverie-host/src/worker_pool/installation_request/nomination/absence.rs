//! Fresh current-instance absence DATA, never an old operation outcome or an
//! activation grant. The application holds actual generation/handler exclusion.
use super::*;
use reverie_contracts::worker_pool::WorkerPoolProvider;

#[must_use = "retain every original observation until checked close"]
pub struct PoolAbsenceObservation {
    source: PathBuf,
    config: ReservationConfiguration,
    files: Option<PrivateBatch>,
    request_path: PathBuf,
    request_stamp: Option<Fingerprint>,
    request: Option<PoolInstallationRequestData>,
    before: Option<GpuPrivateSnapshot>,
    stores: Option<WorkerProtectedStores>,
    immutable: ImmutableInputObserver,
    derived: Option<NominationDerivation>,
    end: Instant,
    close_attempted: bool,
    close_unknown: bool,
    result: Option<serde_json::Value>,
    origin: Option<crate::worker_pool::BrokerBootstrapBinding>,
    origin_failure: Option<Box<crate::worker_pool::BrokerBootstrapFailure>>,
    birth: Option<reverie_contracts::worker_pool::ControllerBirthV2>,
}
impl PoolAbsenceObservation {
    pub fn capture(source: &Path, config: &EffectiveWorkerConfig, end: Instant) -> Self {
        Self {
            source: source.to_owned(),
            config: ReservationConfiguration::capture(config.clone()),
            files: None,
            request_path: PathBuf::new(),
            request_stamp: None,
            request: None,
            before: None,
            stores: None,
            immutable: Default::default(),
            derived: None,
            end,
            close_attempted: false,
            close_unknown: false,
            result: None,
            origin: None,
            origin_failure: None,
            birth: None,
        }
    }
    pub fn observe(&mut self, runtime: &WorkerRuntime) -> Result<()> {
        need(
            self.request.is_none() && !self.close_attempted,
            "POOL_ABSENCE_ALREADY_OBSERVED",
        )?;
        need(
            WorkerPoolProvider::from_config(self.config.configuration())
                .map_err(|_| PoolNominationError::Refused("POOL_ABSENCE_PROVIDER"))?
                .is_none(),
            "POOL_ABSENCE_PROVIDER",
        )?;
        let root = os_root()?;
        self.before = Some(
            GpuControlFiles::capture(&self.source, self.config.configuration())
                .read_configuration()?,
        );
        self.stores = Some(WorkerProtectedStores::capture_pool(&self.config)?);
        self.files = Some(PrivateBatch::new()?);
        let control = native::python_path(&self.config.control_paths()?.root().codepoints())?;
        for leaf in [
            "operations/host-job.intent.json",
            "operations/host-job.finish.pending.json",
        ] {
            need(
                self.files
                    .as_mut()
                    .expect("retained protected reader")
                    .inspect(&control.join(leaf), false, true)?
                    .is_none(),
                "POOL_ABSENCE_HOST_JOB_RETAINED",
            )?;
        }
        self.request_path = root.join("worker-pool/registration-request.json");
        let (stamp, raw) = self
            .files
            .as_mut()
            .expect("retained request reader")
            .read_exact_private_json(&self.request_path)?;
        self.request_stamp = Some(stamp);
        self.request = Some(PoolInstallationRequestData::decode(&raw)?);
        self.observe_origin(runtime)?;
        self.observe_nomination(runtime, &root)?;
        self.observe_census(runtime)?;
        self.encode_observation()
    }
    fn observe_origin(&mut self, runtime: &WorkerRuntime) -> Result<()> {
        self.origin = Some(
            match runtime.retain_pool_installation_offer_bootstrap(&self.source, self.end) {
                Ok(origin) => origin,
                Err(failure) => {
                    let code = failure.primary_error().code();
                    self.origin_failure = Some(failure);
                    return Err(PoolNominationError::Refused(code));
                }
            },
        );
        self.birth = Some(
            self.origin
                .as_mut()
                .expect("same actual origin")
                .birth_document_data(
                    runtime,
                    self.request
                        .as_ref()
                        .expect("same request")
                        .policy()
                        .clone(),
                    self.end,
                )?,
        );
        Ok(())
    }
    fn observe_nomination(&mut self, runtime: &WorkerRuntime, root: &Path) -> Result<()> {
        let reference = compiled_pool_image_inputs_reference()?
            .ok_or(PoolNominationError::Refused("POOL_ABSENCE_FIXED_IMAGES"))?;
        let input = self.immutable.observe_artifact(
            &reference,
            ImmutableInputKind::PoolImageInputs,
            self.end,
        )?;
        let images = PoolImageInputsData::decode(input.bytes())?;
        let original = self.request.as_ref().expect("original nominated request");
        let principal = serde_json::to_vec(&serde_json::json!({"accountId":original.principal().account_id(),
            "personId":original.principal().person_id(),"sessionEpoch":original.principal().session_epoch()}))
            .map_err(|_| PoolNominationError::Refused("POOL_ABSENCE_PRINCIPAL"))?;
        self.derived = Some(NominationDerivation::capture(runtime, self.end));
        let derived = self
            .derived
            .as_mut()
            .expect("same actual native observations");
        let (fresh, _) = derived.derive(runtime, &self.config, &images, &principal, &root)?;
        let mut nonhigh = fresh.policy().clone();
        nonhigh.employee_memory_high_mi_b = original.policy().employee_memory_high_mi_b.clone();
        need(
            nonhigh == *original.policy(),
            "POOL_ABSENCE_CURRENT_BINDINGS",
        )?;
        Ok(())
    }
    fn observe_census(&mut self, runtime: &WorkerRuntime) -> Result<()> {
        self.derived
            .as_mut()
            .expect("same native query owner")
            .assert_census(
                runtime,
                self.request.as_ref().expect("same request").policy(),
                None,
            )?;
        absent_namespace(self.request.as_ref().expect("same request").policy())?;
        self.assert_current()?;
        // Repeat the complete current census after every history observation.
        self.derived
            .as_mut()
            .expect("original native query owner")
            .assert_census(
                runtime,
                self.request.as_ref().expect("same request").policy(),
                None,
            )?;
        absent_namespace(self.request.as_ref().expect("same request").policy())?;
        self.assert_current()?;
        self.origin
            .as_mut()
            .expect("same actual origin")
            .assert_original_current(self.end)?;
        Ok(())
    }
    fn encode_observation(&mut self) -> Result<()> {
        let original = self.request.as_ref().expect("original request");
        let principal = serde_json::json!({"accountId":original.principal().account_id(),
            "personId":original.principal().person_id(),"sessionEpoch":original.principal().session_epoch()});
        let nonce = crate::resource_facts::fresh_owner_nonce()?;
        let epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| PoolNominationError::Refused("POOL_ABSENCE_CLOCK"))?
            .as_millis();
        let epoch =
            u64::try_from(epoch).map_err(|_| PoolNominationError::Refused("POOL_ABSENCE_CLOCK"))?;
        need(
            epoch <= reverie_core::revision::JS_SAFE_MAX - 5000,
            "POOL_ABSENCE_CLOCK",
        )?;
        let original = self.request.as_ref().expect("same nominated request");
        let birth = self.birth.as_ref().expect("original observed process data");
        self.result = Some(
            serde_json::json!({"version":1,"purpose":"worker-pool-uninstalled-observation-v1",
            "nonce":nonce.as_str(),"observedAtEpochMs":epoch,"expiresAtEpochMs":epoch+5000,
            "nominationDigest":original.digest().as_str(),
            "configurationDigest":reverie_contracts::worker_config::config_digest(self.config.configuration()).to_hex(),
            "brokerPid":birth.broker().pid(),"brokerStart":birth.broker().start(),
            "brokerProgramDigest":birth.program().code().sha256.as_str(),
            "principal":principal,
            "websiteContainerId":original.policy().website_container,"uninstalled":true,
            "oldOperationOutcome":"unconfirmed","startsAuthorized":false,"activationAuthorized":false}),
        );
        Ok(())
    }
    pub fn assert_current(&self) -> Result<()> {
        need(
            !self.close_unknown && Instant::now() < self.end,
            "POOL_ABSENCE_UNCONFIRMED",
        )?;
        self.immutable.assert_finalized()?;
        self.files
            .as_ref()
            .ok_or(PoolNominationError::Refused("POOL_ABSENCE_NOT_OBSERVED"))?
            .check()?;
        PrivateBatch::check_exact_private_json(
            &self.request_path,
            self.request_stamp
                .as_ref()
                .ok_or(PoolNominationError::Refused("POOL_ABSENCE_NOT_OBSERVED"))?,
        )?;
        let current = GpuControlFiles::capture(&self.source, self.config.configuration())
            .read_configuration()?;
        need(
            self.before
                .as_ref()
                .is_some_and(|before| before.stamp() == current.stamp())
                && reverie_contracts::gpu_access::private_config_matches(
                    self.config.configuration(),
                    current.metadata(),
                ),
            "POOL_ABSENCE_SOURCE_CHANGED",
        )?;
        need(
            self.stores
                .as_ref()
                .ok_or(PoolNominationError::Refused("POOL_ABSENCE_NOT_OBSERVED"))?
                .unchanged()?,
            "POOL_ABSENCE_STORES_CHANGED",
        )?;
        if let Some(derived) = &self.derived {
            derived.assert_metadata(&self.config)?;
        }
        Ok(())
    }
    pub fn close(&mut self) -> Result<()> {
        if self.close_attempted {
            return need(!self.close_unknown, "POOL_ABSENCE_CLOSE_UNKNOWN");
        }
        self.close_attempted = true;
        let origin = if let Some(origin) = &mut self.origin {
            let current = origin.assert_original_current(self.end).map_err(Into::into);
            finalized(current, origin.close().map_err(Into::into))
        } else {
            self.origin_failure
                .as_mut()
                .map_or(Ok(()), |failure| failure.close().map_err(Into::into))
        };
        let derived = self
            .derived
            .as_mut()
            .map_or(Ok(()), NominationDerivation::close);
        let files = self
            .files
            .as_mut()
            .map_or(Ok(()), |files| files.close().map_err(Into::into));
        let result = finalized(
            finalized(finalized(derived, files), origin),
            self.immutable.assert_finalized().map_err(Into::into),
        );
        self.close_unknown = result.is_err();
        result
    }
    pub fn closed_observation(&self) -> Result<&serde_json::Value> {
        need(
            self.close_attempted && !self.close_unknown,
            "POOL_ABSENCE_CLOSE_REQUIRED",
        )?;
        self.assert_current()?;
        self.result
            .as_ref()
            .ok_or(PoolNominationError::Refused("POOL_ABSENCE_NOT_OBSERVED"))
    }
}
fn absent_namespace(policy: &reverie_contracts::worker_pool::WorkerPoolPolicy) -> Result<()> {
    match fs::symlink_metadata(
        PathBuf::from("/sys/fs/cgroup").join(policy.parent_cgroup_relative()),
    ) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(error.into()),
        Ok(_) => return Err(PoolNominationError::Refused("POOL_ABSENCE_PARENT_RETAINED")),
    }
    need(
        reverie_store::operations::settlement_directory_names(
            &PathBuf::from(&policy.instance_root).join("worker-pool/control"),
        )?
        .is_empty(),
        "POOL_ABSENCE_ENDPOINT_RETAINED",
    )
}
