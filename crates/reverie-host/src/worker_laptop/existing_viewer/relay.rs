//! Actual classified-reuse relay custody; the receipt comes from the SAME
//! original storage acquisition. It is neither a path chooser nor a CLI grant.
use super::*;
/// Fresh read-side DATA, sealed to the same actual resource record. Its bool
/// is never by itself a stop/cleanup/admission permission.
pub struct ExistingViewerReceiptObservation {
    reference: ExistingReference,
    file: bool,
}
impl ExistingViewerReceiptObservation {
    pub fn is_file(&self) -> bool {
        self.file
    }
    pub fn same_owner(&self, owner: &ExistingViewer) -> bool {
        self.reference.same_owner(&owner.reference)
    }
}
impl ExistingRecord {
    pub(in crate::worker_laptop) fn terminal_target(
        &self,
        runtime: &WorkerRuntime,
    ) -> Result<crate::worker_reports::terminal::RelayTarget> {
        let inputs = self
            .inputs
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_EXISTING_VIEWER_CONSUMED"))?;
        let receipt = inputs.receipt.as_ref().ok_or(LaptopError::Refused(
            "WORKER_EXISTING_RELAY_RECEIPT_REQUIRED",
        ))?;
        receipt
            .assert_storage_owner(runtime, &inputs.storage)
            .map_err(LaptopError::StorageOwner)?;
        inputs
            .plan
            .assert_storage_owner(runtime, &inputs.storage)
            .map_err(LaptopError::Plan)?;
        inputs
            .inspected
            .assert_plan(runtime, &inputs.plan)
            .map_err(LaptopError::ExistingObservation)?;
        Ok(crate::worker_reports::terminal::RelayTarget {
            session: inputs.plan.session().clone(),
            exit: receipt.exit_path_data().clone(),
            container: inputs.inspected.data().canonical_id(),
        })
    }
}

#[must_use = "restore every original, including its actual bound receipt"]
pub struct ExistingRelayRetainFailure {
    inner: ExistingViewerRetainFailure,
}
impl ExistingRelayRetainFailure {
    pub fn cause(&self) -> &LaptopError {
        self.inner.cause()
    }
    pub fn into_parts(
        mut self: Box<Self>,
    ) -> (
        Box<LaunchStorage>,
        ObservedCreatePlan,
        WorkerRequest,
        ExistingLaptopInspection,
        LaunchReceiptObservation,
        LaptopError,
    ) {
        // Take the checked receipt BEFORE extracting the original Box. The
        // typed constructor below always supplies Some; fields are private.
        let receipt = self
            .inner
            .inputs
            .receipt
            .take()
            .expect("actual relay receipt");
        let ExistingViewerRetainFailure { inputs, error } = self.inner;
        let Inputs {
            storage,
            plan,
            request,
            inspected,
            receipt: _,
            connection: _,
        } = inputs;
        (storage, plan, request, inspected, receipt, error)
    }
}
/// Like the native-only return guard, default Drop changes nothing. All
/// purpose/phase checks occurred under these SAME actual mutex guards.
#[must_use = "restore atomically under the already checked App registry guard"]
pub struct ExistingRelayReturned<'a> {
    inner: ExistingViewerReturned<'a>,
}
impl ExistingRelayReturned<'_> {
    pub fn into_parts(
        mut self,
    ) -> (
        Box<LaunchStorage>,
        ObservedCreatePlan,
        WorkerRequest,
        ExistingLaptopInspection,
        LaunchReceiptObservation,
        Option<Arc<LaptopError>>,
    ) {
        let receipt = self
            .inner
            .record
            .inputs
            .as_mut()
            .expect("held originals")
            .receipt
            .take()
            .expect("checked relay purpose");
        let (storage, plan, request, inspected, error) = self.inner.into_parts();
        (storage, plan, request, inspected, receipt, error)
    }
}
impl WorkerRuntime {
    pub fn observe_existing_viewer_receipt(
        &self,
        existing: &ExistingViewer,
    ) -> Result<ExistingViewerReceiptObservation> {
        self.laptop_workflows()
            .bound_existing(self, &existing.reference)?;
        let record = existing
            .reference
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_EXISTING_VIEWER_RETAINED"))?;
        let target = record.terminal_target(self)?;
        let file = super::super::viewer::receipt::is_file(&target.exit)?;
        Ok(ExistingViewerReceiptObservation {
            reference: existing.reference.clone(),
            file,
        })
    }
    /// Resource transfer only. App retains actual classified reuse, connection,
    /// early hold and admission until its original release phase completes.
    pub fn retain_existing_relay(
        &self,
        storage: Box<LaunchStorage>,
        plan: ObservedCreatePlan,
        request: WorkerRequest,
        inspected: ExistingLaptopInspection,
        receipt: LaunchReceiptObservation,
    ) -> std::result::Result<ExistingViewer, Box<ExistingRelayRetainFailure>> {
        self.laptop_workflows()
            .retain_existing(
                self,
                Inputs {
                    storage,
                    plan,
                    request,
                    inspected,
                    receipt: Some(receipt),
                    connection: None,
                },
            )
            .map_err(|inner| Box::new(ExistingRelayRetainFailure { inner: *inner }))
    }
    pub fn reclaim_existing_relay<'a>(
        &'a self,
        existing: &'a ExistingViewer,
    ) -> Result<ExistingRelayReturned<'a>> {
        self.laptop_workflows()
            .reclaim_existing(self, existing, true, None)
            .map(|inner| ExistingRelayReturned { inner })
    }
    pub fn reclaim_finalized_existing_relay<'a>(
        &'a self,
        existing: &'a ExistingViewer,
        observation: &ExistingStorageObservation,
    ) -> Result<ExistingRelayReturned<'a>> {
        self.laptop_workflows()
            .reclaim_existing(self, existing, true, Some(observation))
            .map(|inner| ExistingRelayReturned { inner })
    }
    pub fn retain_existing_relay_for_connection(
        &self,
        storage: Box<LaunchStorage>,
        plan: ObservedCreatePlan,
        inspected: ExistingLaptopInspection,
        receipt: LaunchReceiptObservation,
        connection: &crate::worker_reports::WorkerLaunchConnection,
    ) -> std::result::Result<ExistingViewer, Box<ExistingRelayRetainFailure>> {
        let request = connection.request().clone();
        let mut inputs = Inputs {
            storage,
            plan,
            request,
            inspected,
            receipt: Some(receipt),
            connection: None,
        };
        let identity = if self.cancellation().is_cancelled() {
            Err("WORKER_LAPTOP_STOPPED")
        } else {
            connection.viewer_constructor_identity(self, inputs.plan.session())
        };
        match identity {
            Ok(identity) => inputs.connection = Some(identity),
            Err(code) => {
                return Err(Box::new(ExistingRelayRetainFailure {
                    inner: ExistingViewerRetainFailure {
                        inputs,
                        error: LaptopError::Refused(code),
                    },
                }));
            }
        }
        self.laptop_workflows()
            .retain_existing(self, inputs)
            .map_err(|inner| Box::new(ExistingRelayRetainFailure { inner: *inner }))
    }
}
