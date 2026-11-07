//! Capture the ORIGINAL actual J before any network/create effect. Old native
//! component factories never gain transport provenance retrospectively.
use super::*;
use crate::worker_reports::WorkerLaunchConnection;
impl WorkerRuntime {
    pub fn retain_laptop_network_for_connection(
        &self,
        nix: &NixWorkflow,
        plan: ObservedCreatePlan,
        office: OfficePhone,
        connection: &WorkerLaunchConnection,
    ) -> std::result::Result<LaptopWorkflow, Box<LaptopRetainFailure>> {
        let inputs = Inputs {
            plan,
            request: connection.request().clone(),
            office,
        };
        let identity = match connection.viewer_constructor_identity(self, inputs.plan.session()) {
            Ok(identity) => identity,
            Err(code) => {
                return Err(Box::new(LaptopRetainFailure {
                    inputs,
                    error: LaptopError::Refused(code),
                }));
            }
        };
        self.laptop_workflows()
            .retain(self, nix, inputs, Some(identity))
    }
}
