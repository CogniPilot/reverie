//! Read-only C operations share the original accepted record and native query
//! owner. A running container is not proof that its CLI command is healthy.
use super::*;
use reverie_contracts::broker_reply::BrokerReply;
use reverie_contracts::{resource_config::ResourceIdentitySettings, storage_identity::Metadata};
use reverie_store::storage_identity::{self, StorageIdentityConfig};
fn identity_data(error: reverie_contracts::storage_identity::IdentityDataError) -> Cause {
    Cause::Identity(Arc::new(error.into()))
}
pub(super) struct HealthReaders {
    context: crate::reservation_observer::ObservationContext,
    process: reverie_host::website_facts::WebsiteProcessObserver,
    unknown: Option<Arc<crate::reservation_observer::ObserverError>>,
    process_unknown: Option<Arc<reverie_host::website_facts::WebsiteFactsError>>,
}

impl Frame<'_> {
    pub(super) fn close_health_readers(&self) -> Result<(), Cause> {
        let Some(readers) = &self.health else {
            return Ok(());
        };
        let settled = readers.context.settle_metadata_owned(self.end);
        let finalized = readers.process.assert_finalized();
        if let Some(error) = &readers.process_unknown {
            return Err(Cause::Provider(Arc::clone(error)));
        }
        if let Some(error) = &readers.unknown {
            return Err(Cause::Observation(Arc::clone(error)));
        }
        settled.map_err(|e| Cause::Observation(Arc::new(e)))?;
        finalized.map_err(|_| Cause::Refused("PROVIDER_PROCESS_CLOSE_UNCONFIRMED"))
    }
    fn company(&mut self, snapshot: &ValidatedWorkerSnapshot) -> Result<Metadata, Cause> {
        let settings = ResourceIdentitySettings::capture_worker_config(snapshot.configuration())
            .map_err(GateError::from)?;
        let identity = StorageIdentityConfig::capture_worker_settings(&settings);
        storage_identity::read_company_metadata(&identity).map_err(|error| {
            let error = Arc::new(error);
            if error.has_unconfirmed_close() {
                self.identity_unknown
                    .get_or_insert_with(|| Arc::clone(&error));
            }
            Cause::Identity(error)
        })
    }
    pub(super) fn status(&mut self) -> Result<(), Cause> {
        let snapshot = self.broker.configuration()?;
        let company = self.company(&snapshot)?;
        let records = company.company_records().map_err(identity_data)?;
        self.census = Some(
            self.broker
                .storage
                .runtime
                .control_stop_census(snapshot.envelope().base(), self.end)?,
        );
        let before = self
            .census
            .as_mut()
            .expect("same actual C reader")
            .read(&self.broker.storage.runtime)?;
        let mut running = Vec::new();
        for (sid, _) in before.entries() {
            let Some(employee) = records.by_session(sid) else {
                continue;
            };
            let eid = employee.canonical_identity().map_err(identity_data)?;
            if company
                .current_start_allowed(&eid, sid, employee.owner())
                .map_err(identity_data)?
            {
                running.push(sid.as_str().to_owned());
            }
        }
        let after = self
            .census
            .as_mut()
            .expect("same actual C reader")
            .read(&self.broker.storage.runtime)?;
        if before.entries() != after.entries()
            || !company.equivalent(&self.company(&snapshot)?)
            || !Arc::ptr_eq(&snapshot, &self.broker.configuration()?)
        {
            return Err(Cause::Refused("WORKER_CONTROL_STATUS_CHANGED"));
        }
        self.reply_query(serde_json::json!({"runningLaptops":before.entries().len(),
            "runningSessionIds":running,"offlineGraceSeconds":600}))
    }
    pub(super) fn provider_health(&mut self) -> Result<(), Cause> {
        self.end = self.end.min(Instant::now() + Duration::from_secs(5));
        let snapshot = self.broker.configuration()?;
        let company = self.company(&snapshot)?;
        let epoch_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|value| u64::try_from(value.as_millis()).ok())
            .ok_or(Cause::Refused("WORKER_CONTROL_OBSERVATION_CLOCK"))?;
        let bindings = company.provider_health_bindings().map_err(identity_data)?;
        let observations = if bindings.is_empty() {
            Vec::new()
        } else {
            self.observe_health(&snapshot, &bindings, epoch_ms)?
        };
        if !company.equivalent(&self.company(&snapshot)?)
            || !Arc::ptr_eq(&snapshot, &self.broker.configuration()?)
        {
            return Err(Cause::Refused("WORKER_CONTROL_HEALTH_CHANGED"));
        }
        self.reply_query_bytes(
            &BrokerReply::object(vec![(
                "providerHealth",
                BrokerReply::object(vec![
                    ("version", BrokerReply::integer(1)),
                    ("purpose", BrokerReply::string("worker-provider-health-v1")),
                    ("providers", BrokerReply::array(observations)),
                ]),
            )])
            .encode(),
        )
    }
    fn observe_health(
        &mut self,
        snapshot: &ValidatedWorkerSnapshot,
        bindings: &[reverie_contracts::storage_identity::ProviderHealthBinding],
        epoch: u64,
    ) -> Result<Vec<BrokerReply>, Cause> {
        self.health = Some(HealthReaders {
            context: crate::reservation_observer::NativeObserver::capture_worker(
                &self.broker.storage.runtime,
                snapshot.configuration().clone(),
            ),
            process: Default::default(),
            unknown: None,
            process_unknown: None,
        });
        let readers = self.health.as_mut().expect("original C readers");
        let before = readers
            .context
            .inventory(Some(self.end))
            .map_err(|e| Cause::Observation(Arc::new(e)))?;
        let settings = ResourceIdentitySettings::capture_worker_config(snapshot.configuration())
            .map_err(GateError::from)?;
        let identity = StorageIdentityConfig::capture_worker_settings(&settings);
        let mut observations = Vec::new();
        for binding in bindings {
            let result =
                readers.observe_binding(snapshot, &identity, binding, &before, epoch, self.end);
            if let Err(Cause::Identity(error)) = &result
                && error.has_unconfirmed_close()
            {
                self.identity_unknown
                    .get_or_insert_with(|| Arc::clone(error));
                return Err(Cause::Identity(Arc::clone(error)));
            }
            observations.push(readers.known_observation(binding, result, epoch)?);
        }
        let after = readers
            .context
            .inventory(Some(self.end))
            .map_err(|e| Cause::Observation(Arc::new(e)))?;
        if !before.equivalent(&after) {
            return Err(Cause::Refused("PROVIDER_CENSUS_CHANGED"));
        }
        Ok(observations)
    }
    pub(super) fn unsupported_stop(&mut self) -> Result<(), Cause> {
        // This branch precedes every engine call/admission. It never represents
        // an attempted signal, existing stop fence or post-effect uncertainty.
        self.reply_query(
            serde_json::json!({"action":"stop-agent","success":false,"dispatched":false,
            "error":"Native inner-agent stop is unsupported; no signal was dispatched"}),
        )
    }
    fn reply_query(&mut self, value: serde_json::Value) -> Result<(), Cause> {
        let bytes =
            serde_json::to_vec(&value).map_err(|_| Cause::Refused("WORKER_CONTROL_REPLY"))?;
        self.reply_query_bytes(&bytes)
    }
    fn reply_query_bytes(&mut self, bytes: &[u8]) -> Result<(), Cause> {
        self.connection.reply_json(bytes)?;
        self.close_transport()?;
        self.completed = true;
        Ok(())
    }
}
impl HealthReaders {
    fn known_observation(
        &self,
        binding: &reverie_contracts::storage_identity::ProviderHealthBinding,
        result: Result<BrokerReply, Cause>,
        epoch: u64,
    ) -> Result<BrokerReply, Cause> {
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                self.process
                    .assert_finalized()
                    .map_err(|_| Cause::Refused("PROVIDER_PROCESS_CLOSE_UNCONFIRMED"))?;
                if self.unknown.is_some() {
                    return Err(error);
                }
                binding.unknown_observation(epoch).map_err(identity_data)
            }
        }
    }
    fn observe_binding(
        &mut self,
        snapshot: &ValidatedWorkerSnapshot,
        identity: &StorageIdentityConfig,
        binding: &reverie_contracts::storage_identity::ProviderHealthBinding,
        inventory: &crate::reservation_observer::ObservedInventory,
        epoch: u64,
        end: Instant,
    ) -> Result<BrokerReply, Cause> {
        if !binding.eligible() {
            return binding.unknown_observation(epoch).map_err(identity_data);
        }
        let base = snapshot.envelope().base();
        let name = format!(
            "/{}-agent-{}",
            base.deployment(),
            binding.session().as_str()
        );
        let matches = inventory
            .rows()
            .filter(|row| row.data().name_is(&name))
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(Cause::Refused("PROVIDER_SELECTED_ROW"));
        }
        let row = &matches[0];
        let data = row.data();
        let effective = crate::resource_staging::effective_config(
            snapshot.configuration().clone(),
            binding.session(),
        )
        .map_err(GateError::from)?;
        for (key, value) in [
            ("reverie.worker", base.deployment()),
            ("reverie.session", binding.session().as_str()),
            ("reverie.employee", binding.employee().as_str()),
            (
                "reverie.worker-policy",
                &reverie_contracts::worker_config::policy_digest(&effective).to_hex(),
            ),
        ] {
            if !data.label_is(key, value).map_err(GateError::from)? {
                return Err(Cause::Refused("PROVIDER_BINDING"));
            }
        }
        if data.image().map_err(GateError::from)? != base.image() {
            return Err(Cause::Refused("PROVIDER_IMAGE"));
        }
        let paths = storage_identity::storage_paths(identity, binding.session())
            .map_err(|e| Cause::Identity(Arc::new(e)))?;
        if paths.employee() != Some(binding.employee())
            || !storage_identity::storage_start_allowed(identity, &paths)
                .map_err(|e| Cause::Identity(Arc::new(e)))?
        {
            return Err(Cause::Refused("PROVIDER_STORAGE_BINDING"));
        }
        let runtime = identity
            .observe_provider_runtime(&paths)
            .map_err(|e| Cause::Identity(Arc::new(e)))?;
        let storage = self
            .context
            .storage(row, &paths)
            .map_err(|e| self.observation_error(e))?;
        let observed = self
            .context
            .provider_process(&mut self.process, row, end)
            .map_err(|error| {
                let error = Arc::new(error);
                if self.process.assert_finalized().is_err() {
                    self.process_unknown
                        .get_or_insert_with(|| Arc::clone(&error));
                }
                Cause::Provider(error)
            })?;
        let repeated = self
            .context
            .storage(row, &paths)
            .map_err(|e| self.observation_error(e))?;
        if storage.canonical_bytes() != repeated.canonical_bytes() {
            return Err(Cause::Refused("PROVIDER_STORAGE_CHANGED"));
        }
        runtime
            .assert_current(identity)
            .map_err(|e| Cause::Identity(Arc::new(e)))?;
        if runtime.completed()
            || runtime.starting()
            || (!observed.pane_dead() && !observed.live_child())
        {
            return binding.unknown_observation(epoch).map_err(identity_data);
        }
        binding
            .live_observation(
                epoch,
                data.id(),
                observed.init().pid(),
                observed.init().start(),
                observed.pane_dead(),
            )
            .map_err(identity_data)
    }
    fn observation_error(&mut self, error: crate::reservation_observer::ObserverError) -> Cause {
        let error = Arc::new(error);
        if error.has_unconfirmed_close() {
            self.unknown.get_or_insert_with(|| Arc::clone(&error));
        }
        Cause::Observation(error)
    }
}
