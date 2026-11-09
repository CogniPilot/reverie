use super::*;
impl BrokerBootstrapBinding {
    /// Capture an unopened metadata owner from this SAME qualified process.
    /// The caller must store it before publish and retain both actual owners.
    /// This creates no host-administration or controller-activation capability.
    pub fn prepare_birth_publication(
        &mut self,
        runtime: &WorkerRuntime,
        source: &std::path::Path,
        policy: WorkerPoolPolicy,
        end: Instant,
    ) -> Result<ControllerBirthPublication> {
        self.assert_registered_source(runtime, source, end)?;
        let birth = self.birth_document_data(runtime, policy, end)?;
        let owner = ControllerBirthPublication::unopened(runtime, birth, end)?;
        self.assert_registered_source(runtime, source, end)?;
        Ok(owner)
    }
}
