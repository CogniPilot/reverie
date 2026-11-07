//! One recovery attempt owns all uncommitted resources until every constructor
//! succeeds. Cleanup never stops an existing recovered RW laptop.
use super::*;
use reverie_host::office::OfficeConstruction;
use std::time::{Duration, Instant};

pub(super) struct Attempt {
    claims: Vec<(ProfileSessionId, StorageClaim)>,
    phones: Vec<(ProfileSessionId, OfficePhone)>,
    office: Option<Arc<OfficeService>>,
    constructions: Vec<OfficeConstruction>,
}
impl Attempt {
    pub(super) fn new() -> Self {
        Self {
            claims: Vec::new(),
            phones: Vec::new(),
            office: None,
            constructions: Vec::new(),
        }
    }
    pub(super) fn prepare(
        &mut self,
        broker: &InstallingBroker,
        snapshot: &ValidatedWorkerSnapshot,
        selected: &RecoveryNames,
        names: &[(ProfileSessionId, WorkerContainerName)],
        lifecycle: &LaptopLifecycle<'_>,
    ) -> Result<()> {
        self.claim_storage(broker, snapshot.configuration(), selected)?;
        self.open_phones(broker, snapshot, names, lifecycle)
    }
    fn claim_storage(
        &mut self,
        broker: &InstallingBroker,
        source: &reverie_contracts::worker_config::EffectiveWorkerConfig,
        selected: &RecoveryNames,
    ) -> Result<()> {
        // Every selected storage claim/marker validation precedes the first
        // actual Office constructor, including already registered members.
        for (sid, _) in selected.entries() {
            let claim = broker.storage.claim(source, sid)?;
            let paths = claim.paths().clone();
            self.claims.push((sid.clone(), claim));
            if paths.kind() == StorageKind::Employee {
                worker_storage::validate_storage(source, &paths)?;
            }
        }
        Ok(())
    }
    fn open_phones(
        &mut self,
        broker: &InstallingBroker,
        snapshot: &ValidatedWorkerSnapshot,
        names: &[(ProfileSessionId, WorkerContainerName)],
        lifecycle: &LaptopLifecycle<'_>,
    ) -> Result<()> {
        for (sid, _) in names {
            if broker.storage.runtime.cancellation().is_cancelled() {
                return Err(RecoveryError::Refused("WORKER_OFFICE_RECOVERY_STOPPING"));
            }
            // Every production variant owns a genuine Office by construction.
            // Pending name DATA is outside this committed lifecycle registry.
            if lifecycle.guard.iter().any(|entry| &entry.session == sid) {
                continue;
            }
            self.bind_phone(broker, snapshot, sid)?;
        }
        Ok(())
    }
    fn bind_phone(
        &mut self,
        broker: &InstallingBroker,
        snapshot: &ValidatedWorkerSnapshot,
        sid: &ProfileSessionId,
    ) -> Result<()> {
        let office = broker.recovery.office(broker, snapshot)?;
        // Retain the service BEFORE bind, including failed/unknown actual
        // constructors which return no completed phone.
        self.office = Some(office.clone());
        let phone = match office.bind_worker_retained(sid.clone()) {
            Ok(phone) => phone,
            Err(failure) => {
                let (error, construction) = failure.into_parts();
                self.constructions.extend(construction);
                return Err(error.into());
            }
        };
        self.phones.push((sid.clone(), phone));
        Ok(())
    }
    pub(super) fn cleanup(
        mut self,
        broker: &InstallingBroker,
        primary: RecoveryError,
    ) -> RecoveryError {
        let end = broker
            .storage
            .runtime
            .stop_deadline()
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(20));
        let (mut result, native_unknown) = self.close_phones(primary, end);
        for (_, claim) in self.claims.drain(..) {
            if !claim.newly_claimed() {
                continue;
            }
            if native_unknown {
                broker.recovery.retain(claim);
                continue;
            }
            if let Err(failure) = claim.release(end) {
                let (claim, cause) = failure.into_parts();
                broker.recovery.retain(claim);
                result = error::finalized(result, cause.into());
            }
        }
        result
    }
    fn close_phones(&mut self, mut result: RecoveryError, end: Instant) -> (RecoveryError, bool) {
        let Some(office) = &self.office else {
            return (result, false);
        };
        let mut unknown = false;
        for construction in self.constructions.drain(..) {
            if let Err(error) = office.close_construction(&construction, end) {
                unknown = true;
                result = error::finalized(result, error.into());
            }
        }
        for (_, phone) in self.phones.drain(..) {
            if let Err(error) = office.close_phone(&phone, end) {
                unknown = true;
                result = error::finalized(result, error.into());
            }
        }
        (result, unknown)
    }
    pub(super) fn register(
        mut self,
        lifecycle: &mut LaptopLifecycle<'_>,
        names: Vec<(ProfileSessionId, WorkerContainerName)>,
    ) {
        // Every constructor has succeeded before the first publication.
        for (sid, name) in names {
            self.register_one(lifecycle, sid, name);
        }
    }
    fn register_one(
        &mut self,
        lifecycle: &mut LaptopLifecycle<'_>,
        sid: ProfileSessionId,
        name: WorkerContainerName,
    ) {
        let storage = self
            .claims
            .iter()
            .position(|(selected, _)| *selected == sid)
            .map(|at| self.claims.remove(at).1);
        if let Some(existing) = lifecycle
            .guard
            .iter_mut()
            .find(|entry| entry.session == sid)
        {
            existing.name = name;
            replace_storage(&mut existing.owner, storage);
            return;
        }
        let at = self
            .phones
            .iter()
            .position(|(selected, _)| *selected == sid)
            .expect("all missing phones constructed");
        lifecycle.guard.push(LaptopRegistration {
            session: sid,
            name,
            owner: LaptopOwner::Recovered(Box::new(RecoveredLaptop {
                office: Arc::new(RecoveredOffice {
                    _phone: self.phones.remove(at).1,
                    _office: self.office.as_ref().expect("actual Office service").clone(),
                }),
                storage: storage.expect("every new member has its selected storage claim"),
            })),
        });
    }
}
fn replace_storage(owner: &mut LaptopOwner, storage: Option<StorageClaim>) {
    let Some(storage) = storage else { return };
    match owner {
        LaptopOwner::Recovered(owner) => owner.storage = storage,
        LaptopOwner::Started(_) => {
            unreachable!("startup recovery refuses live Started before claiming")
        }
        #[cfg(test)]
        LaptopOwner::Modeled => unreachable!("modeled entries refuse actual recovery"),
    }
}
