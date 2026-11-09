//! Same real maintenance preflight before the short service IMAGE fence. The
//! apply stage recaptures its own original locks and revalidates everything.
use super::*;
use reverie_host::worker_image::ImageMaintenanceLocks;
impl Qualification<'_> {
    pub(super) fn begin_preflight(&mut self) -> Result<()> {
        if reverie_contracts::worker_pool::WorkerPoolProvider::from_config(
            self.before.configuration(),
        )
        .map_err(|_| WorkerImageQualificationError::Refused("WORKER_POOL_PROVIDER_INVALID"))?
        .is_some()
        {
            return Err(WorkerImageQualificationError::Refused(
                "WORKER_IMAGE_POOL_MAINTENANCE_REQUIRED",
            ));
        }
        if reverie_contracts::gpu_access::has_resource_actor(self.before.configuration()) {
            return Err(WorkerImageQualificationError::Refused(
                "WORKER_IMAGE_EXTERNAL_CONSUMER_MAINTENANCE_REQUIRED",
            ));
        }
        let source = self
            .before
            .source_path()
            .ok_or(WorkerImageQualificationError::Refused(
                "WORKER_IMAGE_REGISTERED_SOURCE_REQUIRED",
            ))?;
        match ImageMaintenanceLocks::capture(source, self.before.configuration(), self.end) {
            Ok(locks) => {
                self.preflight_locks = Some(locks);
                Ok(())
            }
            Err(owner) => {
                let cause = owner.cause().clone();
                self.preflight_failure = Some(owner);
                Err(WorkerImageQualificationError::ImageFiles(cause))
            }
        }
    }
    pub(super) fn close_preflight(&mut self) -> Result<()> {
        let mut result = Ok(());
        if let Some(locks) = self.preflight_locks.take() {
            match locks.close() {
                Ok(closed) => {
                    result = closed
                        .assert_current()
                        .map_err(WorkerImageQualificationError::ImageFiles)
                }
                Err(owner) => {
                    let cause = owner.cause().clone();
                    self.preflight_failure = Some(owner);
                    result = Err(WorkerImageQualificationError::ImageFiles(cause));
                }
            }
        }
        let partial = self.preflight_failure.as_mut().map_or(Ok(()), |owner| {
            owner
                .close_components()
                .map_err(WorkerImageQualificationError::ImageFiles)
        });
        match (result, partial) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(e), Ok(())) | (Ok(()), Err(e)) => Err(e),
            (Err(a), Err(b)) => Err(WorkerImageQualificationError::Finalization(
                Box::new(a),
                Box::new(b),
            )),
        }
    }
}
