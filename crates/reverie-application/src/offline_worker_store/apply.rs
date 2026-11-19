//! Apply a reviewed offline seed plan through the exact native maintenance lease.
mod seed;

use super::{Result, Snapshot, observe, snapshot};
use reverie_contracts::worker_nix::offline_qualification::mounts::SeedHelper;
use reverie_core::ids::{OfflineStoreOperationId, ProfileEmployeeId};
use reverie_host::worker_nix::{
    offline_qualification::{ControlPin, Fence, Journal, Lease},
    offline_store_engine::LocalEngine,
};
use serde_json::json;
use std::{cell::OnceCell, fmt, path::Path, time::SystemTime};

pub enum ApplyError {
    Refused(Box<dyn std::error::Error>),
    Unconfirmed(Box<dyn std::error::Error>),
}

impl fmt::Display for ApplyError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(error) => error.fmt(output),
            Self::Unconfirmed(_) => output.write_str(
                "offline outcome or cleanup unconfirmed; do not retry; reconcile employee fence",
            ),
        }
    }
}

pub(super) fn epoch() -> f64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(f64::NAN, |duration| duration.as_secs_f64())
}

pub fn apply(
    config: &Path,
    target: &Path,
    employee: &ProfileEmployeeId,
    operation: &OfflineStoreOperationId,
    expected: &str,
) -> std::result::Result<Vec<u8>, ApplyError> {
    let engine = OnceCell::new();
    let read = |socket: &Path, query| {
        if engine.get().is_none() {
            let _ = engine.set(LocalEngine::open(socket)?);
        }
        engine
            .get()
            .ok_or("local Docker unavailable")?
            .read(socket, query)
    };
    let initial =
        snapshot(config, target, employee, operation, epoch, &read).map_err(ApplyError::Refused)?;
    if initial.plan.digest() != expected {
        return Err(ApplyError::Refused(
            "offline plan changed; no mutation attempted".into(),
        ));
    }
    let attempt = Attempt {
        initial: &initial,
        config,
        target,
        employee,
        operation,
    };
    let lease = attempt
        .locked_admission(&read)
        .map_err(ApplyError::Refused)?;
    let engine = engine
        .get()
        .ok_or_else(|| ApplyError::Refused("local Docker unavailable".into()))?;
    attempt
        .commit(lease, engine)
        .map_err(ApplyError::Unconfirmed)
}

struct Attempt<'a> {
    initial: &'a Snapshot,
    config: &'a Path,
    target: &'a Path,
    employee: &'a ProfileEmployeeId,
    operation: &'a OfflineStoreOperationId,
}

impl Attempt<'_> {
    fn locked_admission(&self, read: super::ReadEngine<'_>) -> Result<Lease> {
        let seat = &self.initial.seat;
        let lease = Lease::acquire(seat, self.uid())?;
        let current =
            observe::inspect_seat(self.config_pin(), seat.paths.session(), self.employee, true)?;
        if current.paths != seat.paths
            || current.locks != seat.locks
            || current.session_lock != seat.session_lock
            || current.helper.arguments() != seat.helper.arguments()
        {
            return Err("private store selection changed".into());
        }
        let current = snapshot(
            self.config,
            self.target,
            self.employee,
            self.operation,
            epoch,
            read,
        )?;
        if current.plan.digest() != self.initial.plan.digest() {
            return Err("locked admission changed".into());
        }
        lease.check()?;
        Ok(lease)
    }

    fn commit(&self, lease: Lease, engine: &LocalEngine) -> Result<Vec<u8>> {
        let path = self.initial.seat.locks.migration_fence();
        let fence = Fence::publish(path, self.uid(), self.marker("PREPARED")?)?;
        let preparing = [
            b"{\"plan\":".as_slice(),
            self.initial.plan.bytes(),
            b",\"state\":\"PREPARED\"}",
        ]
        .concat();
        let journal = Journal::prepare(
            &self.initial.config.roots.audit_directory(),
            self.uid(),
            self.operation.clone(),
            preparing,
        )?;
        let result = self.seed(engine, &lease, &fence, &journal);
        let closed_journal = journal.close();
        let closed_lease = lease.close();
        let receipt = result?;
        closed_journal?;
        closed_lease?;
        fence.complete(&self.marker("COMPLETION_UNCONFIRMED")?)?;
        Ok(receipt)
    }

    fn marker(&self, state: &str) -> Result<Vec<u8>> {
        Ok(serde_json::to_vec(&json!({
            "version": 1,
            "kind": "reverie.offline-store-maintenance",
            "state": state,
            "operationId": self.operation.as_str(),
            "employeeId": self.employee.as_str(),
            "sessionId": self.initial.seat.paths.session().as_str(),
            "imageId": self.initial.target.target.image_id(),
            "planDigest": self.initial.plan.digest(),
        }))?)
    }

    fn config_pin(&self) -> ControlPin<'_> {
        ControlPin {
            path: self.config,
            digest: &self.initial.config.digest,
        }
    }

    fn uid(&self) -> u32 {
        self.initial.config.worker.envelope().base().ids().uid()
    }

    fn check_cohort(&self) -> Result<()> {
        let target = ControlPin {
            path: self.target,
            digest: &self.initial.target.digest,
        };
        observe::verify_cohort(
            &self.initial.config.roots.company_file,
            self.config_pin(),
            target,
            &self.initial.target.target,
        )?;
        Ok(())
    }

    fn require_fresh_admission(&self) -> Result<()> {
        let target = &self.initial.target.target;
        target.require_unexpired(epoch())?;
        self.check_cohort()?;
        let (budget, count) = target.budget()?;
        let roots = &self.initial.config.roots;
        observe::capacity(budget, count, &roots.state, &roots.scratch)?;
        target.require_unexpired(epoch())?;
        Ok(())
    }

    fn seed_helper<'a>(&'a self, store: &'a [u32]) -> SeedHelper<'a> {
        let base = self.initial.config.worker.envelope().base();
        SeedHelper {
            image: self.initial.target.target.image_id(),
            deployment: base.deployment(),
            session: self.initial.seat.paths.session(),
            operation: self.operation,
            user: (base.ids().uid(), base.ids().gid()),
            store,
        }
    }
}
