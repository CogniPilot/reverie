//! Native producer progress DATA. Neither variant establishes resource,
//! admission, storage or service/global settlement.
use crate::engine_metadata::{CleanupFault, EngineError, EngineFault};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeSettlementProgress {
    Settled,
    Pending,
}
pub(crate) fn pending(error: &EngineError) -> bool {
    if error.fault() == EngineFault::Busy && error.cleanup_faults() == [CleanupFault::Supervisor] {
        return true;
    }
    matches!(
        error.fault(),
        EngineFault::Busy
            | EngineFault::Cancelled
            | EngineFault::Deadline
            | EngineFault::Finalization
    ) && !error.cleanup_faults().is_empty()
        && error.cleanup_faults().iter().all(|fault| {
            matches!(
                fault,
                CleanupFault::PendingStart | CleanupFault::Unreaped | CleanupFault::OpenPipes
            )
        })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn error(fault: crate::captured_client::Fault, cleanup: Vec<CleanupFault>) -> EngineError {
        crate::captured_client::Error {
            fault,
            cleanup,
            uncertain: true,
            may_have_started: true,
        }
        .into()
    }
    #[test]
    fn pending_progress_never_hides_signal_identity_or_consumed_close_causes() {
        use crate::captured_client::Fault;
        assert!(pending(&error(Fault::Busy, vec![CleanupFault::Supervisor])));
        assert!(pending(&error(
            Fault::Finalization,
            vec![CleanupFault::Unreaped, CleanupFault::OpenPipes]
        )));
        for cause in [
            CleanupFault::Signal,
            CleanupFault::Identity,
            CleanupFault::StdoutClose,
            CleanupFault::StderrClose,
            CleanupFault::PidfdClose,
            CleanupFault::HandshakeClose,
            CleanupFault::RegistrationClose,
            CleanupFault::Supervisor,
        ] {
            assert!(!pending(&error(
                Fault::Finalization,
                vec![CleanupFault::Unreaped, cause]
            )));
        }
        assert!(!pending(&error(Fault::Finalization, vec![])));
    }
}
