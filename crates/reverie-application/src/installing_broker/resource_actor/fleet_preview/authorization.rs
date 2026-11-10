//! Same qualified Q, explicit closed consent and a separate fresh owner echo.
//! This owner is not installed into the ordinary handler until a genuine
//! same-transition Gate effect consumer exists.
use super::*;
mod binding;
mod drain;
pub use drain::{
    DrainedLegacyFleet, LegacyFleetDrainError, LegacyFleetDrainFailure, PoolMigrationClosed,
    PoolMigrationFailure,
};
mod handlers;
use handlers::OriginalHandlersPhase;
mod migration;
pub(in crate::installing_broker) use migration::PoolMigrationSourceAuthorization;
pub use migration::{AuthenticatedPoolMigration, DrainedPoolMigration};
#[cfg(test)]
mod tests;
mod window;

#[derive(Clone)]
pub struct FleetMaintenanceCheckError {
    cause: Rc<Cause>,
}
impl FleetMaintenanceCheckError {
    pub(super) fn retained(cause: &Rc<Cause>) -> Self {
        Self {
            cause: Rc::clone(cause),
        }
    }
    pub fn code(&self) -> &'static str {
        self.cause.code()
    }
}
impl std::fmt::Debug for FleetMaintenanceCheckError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_tuple("FleetMaintenanceCheckError")
            .field(&self.code())
            .finish()
    }
}
impl std::fmt::Display for FleetMaintenanceCheckError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for FleetMaintenanceCheckError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.cause.as_ref())
    }
}

#[must_use = "retain the actual Q, offer and native scopes until the real maintenance consumer or checked close"]
/// Initial consent and its fresh owner verification must finish within the
/// advertised preview window. Subsequent fresh checks remain bounded by the
/// original frame/offer deadline; they never renew that operation budget.
pub struct AuthenticatedFleetMaintenance<'a> {
    owner: NativeFleetPreview<'a>,
    handlers: OriginalHandlersPhase,
}
impl<'a> QualifiedFleetPreview<'a> {
    /// Send the actual qualified tuple, then read explicit consent and a fresh
    /// owner echo on this SAME Q. No reconnect, borrowed credentials, timeout
    /// renewal or copied preview can construct the returned owner.
    pub fn authenticate_maintenance(
        self,
    ) -> Result<AuthenticatedFleetMaintenance<'a>, Box<FleetPreviewFailure<'a>>> {
        let mut owner = self.owner;
        if let Err(cause) = owner.receive_maintenance_consent() {
            return Err(owner.into_failure(cause));
        }
        Ok(AuthenticatedFleetMaintenance {
            owner,
            handlers: OriginalHandlersPhase::Uncaptured,
        })
    }
}
impl NativeFleetPreview<'_> {
    pub(super) fn retain_check<T>(
        &mut self,
        body: Result<T>,
    ) -> std::result::Result<T, FleetMaintenanceCheckError> {
        body.map_err(|cause| {
            FleetMaintenanceCheckError::retained(self.primary.get_or_insert_with(|| Rc::new(cause)))
        })
    }
    fn receive_maintenance_consent(&mut self) -> Result<()> {
        if let Some(cause) = &self.primary {
            return Err(Cause::Refused(cause.code()));
        }
        self.assert_qualified_native()?;
        self.check_viewer()?;
        self.assert_preview_live()?;
        let binding = self.assert_binding()?;
        self.compare_fixed_images()?;
        self.assert_inputs_current()?;
        let now = owner::epoch()?;
        let (expires, end) = window::consent_window(
            self.original_end(),
            self.viewer
                .as_ref()
                .expect("fresh preview viewer")
                .expires_at_epoch_ms(),
            now,
            Instant::now(),
        )?;
        let reply = self
            .request
            .as_ref()
            .expect("actual preview request")
            .qualified_reply(
                self.selection.as_ref().expect("native qualified tuple"),
                binding.policy(),
                expires,
            )?;
        let frame = self.frame.as_mut().expect("same original Q");
        frame.send(&reply, end)?;
        let consent = self.receive_consent_when_ready(end, expires)?;
        self.maintenance_request = Some(FleetMaintenanceRequest::decode(&consent)?);
        let request = self
            .maintenance_request
            .as_ref()
            .expect("actual consent retained");
        if request.selection() != self.selection.as_ref().expect("native tuple")
            || request.principal()
                != self
                    .request
                    .as_ref()
                    .expect("original preview request")
                    .principal()
        {
            return Err(Cause::Refused("FLEET_MAINTENANCE_APPROVAL_CHANGED"));
        }
        self.refresh_maintenance_owner()?;
        self.assert_qualified_native()?;
        window::assert_window(end, expires)?;
        self.assert_maintenance_live()
    }
    fn receive_consent_when_ready(&mut self, end: Instant, expires: u64) -> Result<HumanFrame> {
        loop {
            window::assert_window(end, expires)?;
            self.assert_preview_live()?;
            let end = end.min(self.original_end());
            let frame = self.frame.as_mut().expect("same original Q");
            frame.guard_peer(end)?;
            if frame
                .channel()?
                .fleet_maintenance_frame_ready(end)
                .map_err(ResourceActorError::from)?
            {
                let request = frame.receive(end)?;
                window::assert_window(end, expires)?;
                return Ok(request);
            }
        }
    }
    fn refresh_maintenance_owner(&mut self) -> Result<()> {
        self.maintenance_checks = self.maintenance_checks.saturating_add(1);
        if self.maintenance_checks > 256 {
            return Err(Cause::Refused("FLEET_MAINTENANCE_CHALLENGE_BOUND"));
        }
        let end = self
            .original_end()
            .min(Instant::now() + Duration::from_millis(OWNER_FRESHNESS_MILLIS));
        let frame = self.frame.as_mut().expect("same original Q");
        frame.guard_bootstrap(end)?;
        let request = self
            .maintenance_request
            .as_ref()
            .expect("actual consent retained");
        let nonce =
            reverie_host::resource_facts::fresh_owner_nonce().map_err(ResourceActorError::from)?;
        frame.send(&request.owner_challenge(&nonce)?, end)?;
        let current = request.parse_owner_reply(&frame.receive(end)?, &nonce)?;
        let viewer = self.viewer.as_ref().expect("original qualified viewer");
        let now = owner::epoch()?;
        if current.expires_at_epoch_ms() <= now
            || current.expires_at_epoch_ms() > now.saturating_add(OWNER_FRESHNESS_MILLIS)
            || current.principal() != viewer.principal()
            || current.scope_digest() != viewer.scope_digest()
            || self.maintenance_owner.as_ref().is_some_and(|old| {
                old.principal() != current.principal()
                    || old.scope_digest() != current.scope_digest()
            })
        {
            return Err(Cause::Refused("FLEET_MAINTENANCE_OWNER_CHANGED_OR_EXPIRED"));
        }
        self.maintenance_owner = Some(current);
        Ok(())
    }
    fn assert_maintenance_live(&self) -> Result<()> {
        self.assert_preview_live()?;
        self.assert_maintenance_owner_live()
    }
    fn assert_maintenance_owner_live(&self) -> Result<()> {
        let current = self
            .maintenance_owner
            .as_ref()
            .ok_or(Cause::Refused("FLEET_MAINTENANCE_OWNER_REQUIRED"))?;
        let now = owner::epoch()?;
        if current.expires_at_epoch_ms() <= now
            || current.expires_at_epoch_ms() > now.saturating_add(OWNER_FRESHNESS_MILLIS)
        {
            return Err(Cause::Refused("FLEET_MAINTENANCE_OWNER_CHANGED_OR_EXPIRED"));
        }
        Ok(())
    }
}
impl<'a> AuthenticatedFleetMaintenance<'a> {
    pub fn selection(&self) -> &reverie_contracts::reservation_control::PoolTransitionSelection {
        self.owner
            .selection
            .as_ref()
            .expect("actual native tuple retained")
    }
    pub fn assert_reservation_gate(
        &self,
        gate: &crate::reservation_gate::ReservationGate,
    ) -> std::result::Result<(), FleetMaintenanceCheckError> {
        if let Some(cause) = &self.owner.primary {
            return Err(FleetMaintenanceCheckError::retained(cause));
        }
        let body = (|| {
            if !self
                .owner
                .frame
                .as_ref()
                .expect("same Q")
                .broker
                .resource_reservations()?
                .is_some_and(|actual| std::ptr::eq(actual, gate))
            {
                return Err(Cause::Refused("FLEET_MAINTENANCE_GATE_CHANGED"));
            }
            self.owner.assert_maintenance_live()
        })();
        self.check_result(body)
    }
    pub fn assert_current(&mut self) -> std::result::Result<(), FleetMaintenanceCheckError> {
        if let Some(cause) = &self.owner.primary {
            return Err(FleetMaintenanceCheckError::retained(cause));
        }
        let body = self
            .owner
            .assert_qualified_native()
            .and_then(|()| self.owner.refresh_maintenance_owner())
            .and_then(|()| self.owner.assert_qualified_native())
            .and_then(|()| self.owner.assert_maintenance_live());
        self.owner.retain_check(body)
    }
    /// Metadata, original optional-offer binding, expiry and socket only.
    /// This opens no fresh engine/company/input/query scope inside admission.
    pub fn assert_live(&self) -> std::result::Result<(), FleetMaintenanceCheckError> {
        if let Some(cause) = &self.owner.primary {
            return Err(FleetMaintenanceCheckError::retained(cause));
        }
        self.check_result(self.owner.assert_maintenance_live())
    }
    fn check_result<T>(
        &self,
        body: Result<T>,
    ) -> std::result::Result<T, FleetMaintenanceCheckError> {
        if let Some(cause) = &self.owner.primary {
            return Err(FleetMaintenanceCheckError::retained(cause));
        }
        body.map_err(|cause| FleetMaintenanceCheckError {
            cause: Rc::new(cause),
        })
    }
    pub fn close(self) -> Result<FleetPreviewClosed, Box<FleetPreviewFailure<'a>>> {
        Box::new(FleetPreviewFailure { owner: self.owner }).close()
    }
}
