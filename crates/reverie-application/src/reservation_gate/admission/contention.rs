//! Bounded pre-admission backpressure. Only a typed, checked-clean lock
//! contention may be retried; no launch, cleanup or native effect is replayed.
use super::*;
use reverie_host::reservation_control::AdmissionLockAttempt;

impl Inner {
    pub(super) fn acquire_contended_entry(
        &self,
        config: &reverie_contracts::reservation_engine::ReservationConfiguration,
        end: Instant,
    ) -> Result<AdmissionLock> {
        let cancellation = self.observer.cancellation();
        let mut lock = loop {
            need(
                !cancellation.is_cancelled(),
                "RESERVATION_ADMISSION_CANCELLED",
            )?;
            self.assert_no_pool_transition()?;
            let remaining = end.saturating_duration_since(Instant::now());
            need(!remaining.is_zero(), "RESERVATION_ADMISSION_DEADLINE")?;
            match AdmissionLock::try_acquire(config)? {
                AdmissionLockAttempt::Acquired(lock) => break lock,
                AdmissionLockAttempt::Contended => {
                    std::thread::sleep(remaining.min(Duration::from_millis(20)))
                }
            }
        };
        if Instant::now() >= end || cancellation.is_cancelled() {
            let code = if cancellation.is_cancelled() {
                "RESERVATION_ADMISSION_CANCELLED"
            } else {
                "RESERVATION_ADMISSION_DEADLINE"
            };
            return finalized(
                Err(GateError::Refused(code)),
                lock.close().map_err(Into::into),
            );
        }
        Ok(lock)
    }
}
