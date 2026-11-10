//! Fresh uninstalled-state observation under this actual C's generation and
//! handler exclusion. Never an old-operation outcome or a migration permit.
use super::*;
impl Frame<'_> {
    pub(super) fn pool_recovery_status(&mut self) -> Result<(), Cause> {
        self.end = self.end.min(Instant::now() + Duration::from_secs(30));
        let snapshot = self.broker.configuration()?;
        let source = snapshot
            .source_path()
            .ok_or(Cause::Refused("POOL_ABSENCE_SOURCE_REQUIRED"))?;
        if self
            .broker
            .controller
            .try_lock()
            .map_err(|_| Cause::Refused("POOL_ABSENCE_CONTROLLER_RETAINED"))?
            .is_some()
        {
            return Err(Cause::Refused("POOL_ABSENCE_CONTROLLER_RETAINED"));
        }
        self.recovery_drain = Some(
            self.broker
                .installed
                .lifecycle()?
                .begin_uninstalled_observation()?,
        );
        self.recovery_exclusion =
            Some(self.connection.retain_empty_recovery_handlers(
                &self.broker.reports,
                &self.broker.storage.runtime,
            )?);
        self.absence = Some(reverie_host::worker_pool::PoolAbsenceObservation::capture(
            source,
            snapshot.configuration(),
            self.end,
        ));
        let owner = self.absence.as_mut().expect("same original observation");
        owner.observe(&self.broker.storage.runtime).map_err(pool)?;
        owner.close().map_err(pool)?;
        let mut value = owner.closed_observation().map_err(pool)?.clone();
        value["lifecycleGeneration"] = serde_json::Value::String(
            self.recovery_drain
                .as_ref()
                .expect("original generation exclusion")
                .serial_data()
                .to_owned(),
        );
        self.assert_recovery_exclusion()?;
        if self
            .broker
            .controller
            .try_lock()
            .map_err(|_| Cause::Refused("POOL_ABSENCE_CONTROLLER_RETAINED"))?
            .is_some()
        {
            return Err(Cause::Refused("POOL_ABSENCE_CONTROLLER_RETAINED"));
        }
        if !Arc::ptr_eq(&snapshot, &self.broker.configuration()?) {
            return Err(Cause::Refused("POOL_ABSENCE_CONFIGURATION_CHANGED"));
        }
        self.connection.reply_json(
            &serde_json::to_vec(&value).map_err(|_| Cause::Refused("WORKER_CONTROL_REPLY"))?,
        )?;
        self.close_transport()?;
        self.completed = true;
        Ok(())
    }
    fn assert_recovery_exclusion(&self) -> Result<(), Cause> {
        self.recovery_exclusion
            .as_ref()
            .ok_or(Cause::Refused("POOL_ABSENCE_HANDLERS_UNAVAILABLE"))?
            .assert_current(
                &self.connection,
                &self.broker.reports,
                &self.broker.storage.runtime,
            )?;
        self.broker.installed.lifecycle()?.assert_service_drain(
            self.recovery_drain
                .as_ref()
                .ok_or(Cause::Refused("POOL_ABSENCE_GENERATION_UNAVAILABLE"))?,
        )?;
        Ok(())
    }
    pub(super) fn close_recovery_observation(&mut self) -> Result<(), Cause> {
        if let Some(owner) = &mut self.absence {
            owner.close().map_err(pool)?;
        }
        if let Some(drain) = &self.recovery_drain {
            self.broker
                .installed
                .lifecycle()?
                .finish_control_drain(drain)?;
            self.recovery_drain = None;
        }
        Ok(())
    }
}
fn pool(cause: reverie_host::worker_pool::PoolNominationError) -> Cause {
    Cause::Pool(Rc::new(cause))
}
