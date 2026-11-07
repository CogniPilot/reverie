//! Actual classified-reuse relay custody; the receipt comes from the SAME
//! original storage acquisition. It is neither a path chooser nor a CLI grant.
use super::*;

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
                },
            )
            .map_err(|inner| Box::new(ExistingRelayRetainFailure { inner: *inner }))
    }
    pub fn reclaim_existing_relay<'a>(
        &'a self,
        existing: &'a ExistingViewer,
    ) -> Result<ExistingRelayReturned<'a>> {
        self.laptop_workflows()
            .reclaim_existing(self, existing, true)
            .map(|inner| ExistingRelayReturned { inner })
    }
}
