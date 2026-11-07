use super::*;
impl ReservationGate {
    #[cfg(test)]
    pub(crate) fn pause_next_entry_capture(
        &self,
        pause: crate::test_process::PausePoint<ObservationContext>,
    ) {
        assert!(
            self.inner
                .entry_capture_pause
                .lock()
                .unwrap()
                .replace(pause)
                .is_none()
        );
    }
    #[cfg(test)]
    pub(crate) fn owned_context_for_test(&self) -> Result<ObservationContext> {
        self.inner.native_context()
    }
    pub(crate) fn publish_launch_image(
        &self,
        proof: crate::installing_broker::LoadedLaunchImage,
        lifecycle: &crate::installing_broker::LaptopLifecycle<'_>,
    ) -> Result<Arc<ValidatedWorkerSnapshot>> {
        need(
            lifecycle.belongs_to(self.inner.installed.as_ref()),
            "WORKER_LAUNCH_IMAGE_LIFECYCLE_CHANGED",
        )?;
        need(
            self.inner.source_path.as_deref() == Some(proof.source()),
            "WORKER_LAUNCH_IMAGE_SOURCE_CHANGED",
        )?;
        let state = self
            .inner
            .state
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        let mut context = state
            .active
            .as_ref()
            .map(|active| {
                active
                    .context
                    .lock()
                    .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))
            })
            .transpose()?;
        self.inner
            .installed
            .publish_launch_image(proof, lifecycle, context.as_deref_mut())
    }
}
