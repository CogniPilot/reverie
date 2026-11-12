//! One diagnostic attempt on the original authorized Q. Sending, failure or
//! loss of this reply never closes/releases/replays the native operation.
use super::*;

#[derive(Default)]
pub(super) enum MigrationReply {
    #[default]
    Available,
    Attempted {
        error: Option<Rc<Cause>>,
    },
}
impl MigrationReply {
    fn begin(&mut self) -> bool {
        if !matches!(self, Self::Available) {
            return false;
        }
        *self = Self::Attempted { error: None };
        true
    }
    fn retain(&mut self, cause: Cause) {
        if let Self::Attempted { error } = self {
            error.get_or_insert_with(|| Rc::new(cause));
        }
    }
    pub(super) fn error(&self) -> Option<&Cause> {
        match self {
            Self::Available => None,
            Self::Attempted { error } => error.as_deref(),
        }
    }
    pub(super) fn retained_error(&self) -> Option<Rc<Cause>> {
        match self {
            Self::Available => None,
            Self::Attempted { error } => error.as_ref().map(Rc::clone),
        }
    }
}
impl NativeFleetPreview<'_> {
    pub(super) fn begin_migration_reply(&mut self) -> Result<()> {
        if !self.migration_reply.begin() {
            return Err(Cause::Refused("POOL_MIGRATION_REPLY_ALREADY_ATTEMPTED"));
        }
        Ok(())
    }
    pub(super) fn notify_migration_failure(&mut self, code: &'static str) {
        // Malformed/foreign consent must never acquire a correlated reply.
        let Some(request) = &self.maintenance_request else {
            return;
        };
        if request.action() != FleetMaintenanceAction::MigratePool
            || self.selection.as_ref() != Some(request.selection())
            || !self
                .request
                .as_ref()
                .is_some_and(|preview| preview.principal() == request.principal())
            || self.viewer.is_none()
            || !self.migration_reply.begin()
        {
            return;
        }
        let body = self.send_migration_failure(code);
        if let Err(cause) = body {
            self.migration_reply.retain(cause);
        }
    }
    fn send_migration_failure(&mut self, code: &'static str) -> Result<()> {
        // A fresh echo is required even on an error. It uses the same original
        // frame/offer/first-stop bound; expired/revoked owners get no reply.
        self.refresh_maintenance_owner()?;
        self.assert_maintenance_owner_live()?;
        let reply = self
            .maintenance_request
            .as_ref()
            .expect("same checked consent")
            .migration_failure(code)?;
        let now = owner::epoch()?;
        let expires = self
            .maintenance_owner
            .as_ref()
            .expect("fresh original owner")
            .expires_at_epoch_ms();
        let remaining = expires
            .checked_sub(now)
            .filter(|remaining| *remaining > 0)
            .ok_or(Cause::Refused("FLEET_MAINTENANCE_OWNER_CHANGED_OR_EXPIRED"))?;
        let end = self
            .original_end()
            .min(Instant::now() + Duration::from_millis(remaining));
        self.frame
            .as_mut()
            .expect("same retained Q")
            .send(&reply, end)?;
        self.assert_maintenance_owner_live()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_reply_attempt_is_one_shot_and_retains_first_independent_error() {
        let mut reply = MigrationReply::default();
        assert!(reply.begin());
        reply.retain(Cause::Refused("FIRST_SEND_FAILURE"));
        assert!(!reply.begin());
        reply.retain(Cause::Refused("LATER_SEND_FAILURE"));
        assert_eq!(reply.error().unwrap().code(), "FIRST_SEND_FAILURE");
    }
}
