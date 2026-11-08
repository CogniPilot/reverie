//! Read-only C operations share the original accepted record and native query
//! owner. A running container is not proof that its CLI command is healthy.
use super::*;
use reverie_contracts::broker_reply::BrokerReply;
use reverie_contracts::{resource_config::ResourceIdentitySettings, storage_identity::Metadata};
use reverie_store::storage_identity::{self, StorageIdentityConfig};
fn identity_data(error: reverie_contracts::storage_identity::IdentityDataError) -> Cause {
    Cause::Identity(Arc::new(error.into()))
}

impl Frame<'_> {
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
        let snapshot = self.broker.configuration()?;
        let company = self.company(&snapshot)?;
        let epoch_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|value| u64::try_from(value.as_millis()).ok())
            .ok_or(Cause::Refused("WORKER_CONTROL_OBSERVATION_CLOCK"))?;
        let bindings = company.provider_health_bindings().map_err(identity_data)?;
        // Unknown rows retain their exact current-company tuple. Neither a
        // container nor its terminal viewer supplies positive command proof.
        let observations = bindings
            .iter()
            .map(|binding| binding.unknown_observation(epoch_ms).map_err(identity_data))
            .collect::<Result<Vec<_>, _>>()?;
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
