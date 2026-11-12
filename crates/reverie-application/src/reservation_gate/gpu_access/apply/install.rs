use super::*;
impl<P: Platform> Service<'_, P> {
    pub(super) fn install(
        &self,
        record: &Arc<TransitionRecord>,
        active: &Active,
        lifecycle: &crate::installing_broker::LaptopLifecycle<'_>,
        end: Instant,
        website: Option<&mut WebsiteGpuApply<'_, '_>>,
    ) -> Result<()> {
        if let Some(website) = website.as_ref() {
            website.assert_live(self.gate)?;
        }
        let proof = record.publish_files(active)?;
        if let Some(website) = website {
            let actor = record.actor_publication()?;
            if let Err(error) = website.operation.assert_gpu_actor_rebound(
                &record.before,
                &record.after,
                &actor,
                end,
            ) {
                return Err(website.retain_rebound_error(error));
            }
            website.assert_budget()?;
            self.gate.inner.publish_gpu(proof, lifecycle)?;
            website
                .operation
                .accept_gpu_actor_rebound(&record.before, &record.after, &actor)?;
        } else {
            self.gate.inner.publish_gpu(proof, lifecycle)?;
        }
        Ok(())
    }
}
