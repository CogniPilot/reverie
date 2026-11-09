//! A weak currentness observer of the SAME actual greeted B transport. This
//! does not attest its website program, accept consent or grant administration.
use super::*;

/// The actual attested installation website owner must independently retain
/// its native program, current account/consent and exact enrollment offer.
/// This non-Clone pin only observes its original counted B channel lifetime.
pub struct PoolRegistrationPin {
    native: super::current_pin::ActorCurrentPin,
}
impl WorkerActorChannel {
    /// Same-service B/open/greeted transport only. The actual App installation
    /// website owner must separately perform native attestation/currentness;
    /// a greeting or this weak pin never substitutes for that proof or consent.
    pub fn retain_pool_registration_pin(
        &self,
        expected: &Arc<WorkerReportService>,
    ) -> std::result::Result<PoolRegistrationPin, WorkerActorPinError> {
        self.retain_pool_registration_pin_native(expected)
            .map_err(Into::into)
    }
    fn retain_pool_registration_pin_native(
        &self,
        expected: &Arc<WorkerReportService>,
    ) -> Result<PoolRegistrationPin> {
        self.assert_service(expected)?;
        if self.purpose != Purpose::PoolRegistrationWebsite
            || !self.greeted
            || self.close != ClosePhase::Open
        {
            return Err(WorkerReportError::Unconfirmed);
        }
        Ok(PoolRegistrationPin {
            native: super::current_pin::ActorCurrentPin::capture(
                self,
                super::current_pin::PinPurpose::PoolRegistration,
            )?,
        })
    }
}
impl PoolRegistrationPin {
    /// Nonblocking original Record/Hold membership, sole peer pidfd and strict
    /// socket FIN observation, including FIN behind buffered unread bytes.
    pub fn assert_current(&self) -> std::result::Result<(), WorkerActorPinError> {
        self.native.current().map_err(Into::into)
    }
}
