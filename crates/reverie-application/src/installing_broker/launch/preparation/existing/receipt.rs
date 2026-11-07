//! Read runtime metadata only after the actual running-policy/native phase.
//! Keep exit.exists distinct from regular-file completion and inner-pane state.
use super::{memory::VerifiedExistingWorkerLaunch, *};
use reverie_host::worker_storage::LaunchReceiptObservation;
struct RuntimeWorkerLaunch<'a> {
    verified: VerifiedExistingWorkerLaunch<'a>,
    receipt: Option<LaunchReceiptObservation>,
}
impl<'a> VerifiedExistingWorkerLaunch<'a> {
    fn read_runtime(self) -> Result<RuntimeWorkerLaunch<'a>, Box<PreparationFailure<'a>>> {
        if !self.running {
            return Ok(RuntimeWorkerLaunch {
                verified: self,
                receipt: None,
            });
        }
        let read = self
            .existing
            .observed
            .claimed
            .storage
            .as_ref()
            .expect("same actual claimed owner")
            .observe_launch_receipt();
        match read {
            Ok(receipt) => Ok(RuntimeWorkerLaunch {
                verified: self,
                receipt: Some(receipt),
            }),
            Err(error) => Err(self
                .existing
                .observed
                .claimed
                .into_failure(error.into(), Some(self.existing.observed.current))),
        }
    }
}

#[cfg(test)]
mod tests;
