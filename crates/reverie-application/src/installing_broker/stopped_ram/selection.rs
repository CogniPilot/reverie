use super::*;
use reverie_contracts::{
    resource_config::ResourceIdentitySettings, worker_config::EffectiveWorkerConfig,
};
pub(super) struct Selection {
    pub(super) current: CurrentEmployee,
    employee: ClaimEmployee,
    identity: StorageIdentityConfig,
    pub(super) start_allowed: bool,
}
impl Selection {
    pub(super) fn capture(config: &EffectiveWorkerConfig, eid: &ProfileEmployeeId) -> Result<Self> {
        let settings =
            ResourceIdentitySettings::capture_worker_config(config).map_err(GateError::from)?;
        let identity = StorageIdentityConfig::capture_worker_settings(&settings);
        let company =
            storage_identity::read_company_metadata(&identity).map_err(GateError::from)?;
        let employee = ClaimEmployee::capture(&company, eid).map_err(GateError::from)?;
        let sid = employee.selection_session().map_err(GateError::from)?;
        employee.selection_generation().map_err(GateError::from)?;
        let current = storage_identity::current_employee(&identity, &sid)
            .map_err(GateError::from)?
            .ok_or(Cause::Refused("RAM_STOPPED_CURRENT_EMPLOYEE_REQUIRED"))?;
        if current.identity() != eid {
            return Err(Cause::Refused("RAM_STOPPED_CURRENT_EMPLOYEE_REQUIRED"));
        }
        let paths = storage_identity::storage_paths(&identity, &sid).map_err(GateError::from)?;
        let start_allowed =
            storage_identity::storage_start_allowed(&identity, &paths).map_err(GateError::from)?;
        let selected = Self {
            current,
            employee,
            identity,
            start_allowed,
        };
        selected.assert_metadata()?;
        Ok(selected)
    }
    pub(super) fn assert_metadata(&self) -> Result<()> {
        let metadata =
            storage_identity::read_company_metadata(&self.identity).map_err(GateError::from)?;
        if !self
            .employee
            .still_current(&metadata)
            .map_err(GateError::from)?
            || storage_identity::current_employee(&self.identity, self.current.session())
                .map_err(GateError::from)?
                .as_ref()
                != Some(&self.current)
        {
            return Err(Cause::Refused("RAM_STOPPED_EMPLOYEE_CHANGED"));
        }
        Ok(())
    }
}
pub(super) fn check_source(current: &CurrentEmployee, source: &StoppedRamSource) -> Result<()> {
    if source.paths().employee() != Some(current.identity())
        || source.paths().session() != current.session()
        || source.paths().owner() != current.owner()
    {
        return Err(Cause::Refused("RAM_STOPPED_EMPLOYEE_LEASE_CHANGED"));
    }
    Ok(())
}
pub(super) fn check_lifecycle(life: &LaptopLifecycle<'_>, sid: &ProfileSessionId) -> Result<()> {
    life.check_stopped_ram_available(sid).map_err(Into::into)
}
