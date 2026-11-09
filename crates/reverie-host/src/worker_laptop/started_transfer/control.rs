//! C consumes only an idle original Created owner, never a synthetic next J.
use super::*;
use crate::worker_source_stop::ControlLaptopStop;
use reverie_contracts::worker_config::EffectiveWorkerConfig;

pub struct StartedControlStopTransferred {
    stop: ControlLaptopStop,
    office: OfficePhone,
}
impl StartedControlStopTransferred {
    pub fn into_parts(self) -> (ControlLaptopStop, OfficePhone) {
        (self.stop, self.office)
    }
}
impl WorkerRuntime {
    pub fn transfer_idle_laptop_control_stop(
        &self,
        created: &CreatedLaptop,
        current: &EffectiveWorkerConfig,
        end: Instant,
    ) -> Result<StartedControlStopTransferred> {
        let workflows = self.laptop_workflows();
        let record = workflows.started_storage_record(self, created)?;
        let resources = record.resources();
        resources
            .connection
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_STARTED_CONNECTION_REQUIRED"))?
            .require_released()
            .map_err(LaptopError::Refused)?;
        require_closed(self, &record, &resources.plan)?;
        resources
            .storage()
            .assert_binding(self, current, resources.plan.session())
            .map_err(LaptopError::StorageOwner)?;
        let inventory = workflows
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            inventory
                .iter()
                .any(|entry| entry.is_created(&created.workflow.record)),
            "WORKER_LAPTOP_REPLAYED",
        )?;
        let mut transfer = Transfer {
            record,
            inventory,
            identity: &created.workflow.record,
        };
        let container = transfer
            .record
            .creation
            .as_ref()
            .and_then(|creation| creation.container.clone())
            .ok_or(LaptopError::Refused("WORKER_CONTROL_STOP_CREATED_CID"))?;
        let (storage, rest) = transfer.take();
        match self.retain_control_laptop_stop(storage, current, end) {
            Ok(mut stop) => {
                stop.bind_created_identity(container);
                let (office, _request) = transfer.consumed(rest);
                Ok(StartedControlStopTransferred { stop, office })
            }
            Err(failure) => {
                let (storage, cause) = *failure;
                transfer.restore(storage, rest);
                Err(LaptopError::OrdinaryStop(cause))
            }
        }
    }
}
