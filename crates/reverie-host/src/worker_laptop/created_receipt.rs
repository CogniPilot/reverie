//! Cleanup reads the actual publication's selected nonce, not later editable
//! runtime.json. Observation is DATA and grants no stop/release permission.
use super::*;
use reverie_core::posix_path::PosixPath;
pub struct CreatedReceiptObservation {
    workflow: LaptopWorkflow,
    file: bool,
}
impl CreatedReceiptObservation {
    pub fn is_file(&self) -> bool {
        self.file
    }
    pub fn same_workflow(&self, other: &LaptopWorkflow) -> bool {
        self.workflow.same_workflow(other)
    }
}
impl WorkerRuntime {
    /// Checked target DATA for App's real fresh stop admission. This performs
    /// no inspection/effect and cannot select another container or resource.
    pub fn created_laptop_stop_target(
        &self,
        created: &CreatedLaptop,
    ) -> Result<reverie_core::worker_laptop::WorkerContainerName> {
        self.laptop_workflows().bound(self, &created.workflow)?;
        let record = created
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        let resources = record
            .resources
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_LAPTOP_REPLAYED"))?;
        resources
            .plan
            .assert_storage_owner(self, resources.storage())
            .map_err(LaptopError::Plan)?;
        Ok(
            reverie_core::worker_laptop::WorkerContainerName::from_launch_name_data(
                resources.plan.arguments().worker_name(),
            ),
        )
    }
    /// Valid during Held/retained construction too. There is deliberately no
    /// forward J/socket requirement: source observes completion before cleanup.
    pub fn observe_created_laptop_receipt(
        &self,
        created: &CreatedLaptop,
    ) -> Result<CreatedReceiptObservation> {
        self.laptop_workflows().bound_with_contention(
            self,
            &created.workflow,
            ReadContention::CreatedReceipt,
        )?;
        let record = created
            .workflow
            .record
            .try_lock()
            .map_err(|error| ReadContention::CreatedReceipt.error(error))?;
        let creation = record
            .creation
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_LAPTOP_CREATED_OWNER_REQUIRED"))?;
        need(
            creation.owns_created() && record.resources.is_some(),
            "WORKER_LAPTOP_CREATED_OWNER_REQUIRED",
        )?;
        let selected = creation
            .publication
            .as_ref()
            .and_then(publication::Publication::selected_exit);
        let file = match selected {
            None => false,
            Some(path) => {
                let path = PosixPath::try_new(&crate::native::python_text(&path))
                    .map_err(|_| LaptopError::Refused("WORKER_CREATED_RECEIPT_PATH"))?;
                viewer::receipt::is_file(&path)?
            }
        };
        Ok(CreatedReceiptObservation {
            workflow: created.workflow.clone(),
            file,
        })
    }
}
