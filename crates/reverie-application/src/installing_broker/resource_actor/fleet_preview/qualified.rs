//! Actual original-Q/offer/package-image join. The public type has no public
//! fields, copied-DATA constructor, drain method or parent activation method.
use super::*;

#[must_use = "retain this original qualified preview through consent or checked component close"]
pub struct QualifiedFleetPreview<'a> {
    pub(super) owner: NativeFleetPreview<'a>,
}
impl InstallingBroker {
    /// Separate producer API. The ordinary readonly service route remains a
    /// target-verification-required query until a real effect consumer joins.
    pub fn prepare_fleet_preview<'a>(
        self: &'a Arc<Self>,
        connection: WorkerServiceConnection,
        view: OfferPreparationView,
    ) -> Result<QualifiedFleetPreview<'a>, Box<FleetPreviewFailure<'a>>> {
        // Consume BOTH actual owners before even a wrong-origin check.
        let mut owner = NativeFleetPreview::incoming(self, connection, TargetAttempt::View(view));
        let body = owner
            .prepare(self)
            .and_then(|()| owner.qualify_fixed_inputs());
        if let Err(cause) = body {
            return Err(owner.into_failure(cause));
        }
        Ok(QualifiedFleetPreview { owner })
    }
}
impl<'a> NativeFleetPreview<'a> {
    pub(super) fn qualify_fixed_inputs(&mut self) -> Result<()> {
        self.read_fixed_inputs()?;
        self.assert_qualified_native()?;
        self.check_viewer()?;
        self.assert_qualified_native()?;
        self.assert_viewer_live()?;
        self.assert_preview_live()?;
        let binding = self.assert_binding()?;
        self.compare_fixed_images()?;
        self.assert_inputs_current()?;
        self.selection = Some(
            self.coverage
                .as_ref()
                .expect("original native coverage")
                .qualified_selection(
                    &binding,
                    self.inputs.as_ref().expect("actual fixed inputs"),
                )?,
        );
        self.assert_viewer_live()?;
        self.assert_preview_live()
    }
    pub(super) fn assert_qualified_native(&mut self) -> Result<()> {
        let end = self.original_end();
        self.frame
            .as_mut()
            .expect("same original Q")
            .guard_bootstrap(end)?;
        self.assert_binding()?;
        self.coverage
            .as_ref()
            .expect("original native coverage")
            .assert_current(self.frame.as_mut().expect("same original Q"), end)?;
        self.compare_fixed_images()?;
        self.assert_inputs_current()?;
        self.assert_preview_live()
    }
    pub(super) fn assert_preview_live(&self) -> Result<()> {
        let frame = self.frame.as_ref().expect("same original Q");
        frame.assert_metadata(self.original_end())?;
        let request = self.request.as_ref().expect("actual preview request");
        self.target
            .as_ref()
            .expect("same original target")
            .binding(frame, request.principal())?;
        let Transport::Retained(channel) = &frame.transport else {
            return Err(Cause::Refused("RESOURCE_ACTOR_CHANNEL_STATE"));
        };
        channel
            .require_connected()
            .map_err(ResourceActorError::from)?;
        Ok(())
    }
    pub(super) fn assert_viewer_live(&self) -> Result<()> {
        let viewer = self
            .viewer
            .as_ref()
            .ok_or(Cause::Refused("FLEET_PREVIEW_VIEWER_REQUIRED"))?;
        let now = owner::epoch()?;
        if viewer.expires_at_epoch_ms() <= now
            || viewer.expires_at_epoch_ms() > now.saturating_add(OWNER_FRESHNESS_MILLIS)
        {
            return Err(Cause::Refused("FLEET_PREVIEW_VIEWER_CHANGED_OR_EXPIRED"));
        }
        Ok(())
    }
    pub(super) fn into_failure(mut self, cause: Cause) -> Box<FleetPreviewFailure<'a>> {
        self.primary.get_or_insert_with(|| Rc::new(cause));
        self.notify_migration_failure(self.primary.as_ref().expect("retained primary").code());
        Box::new(FleetPreviewFailure { owner: self })
    }
}
impl<'a> QualifiedFleetPreview<'a> {
    /// Fresh readonly observation only. This cannot establish maintenance,
    /// stop a handler, create a controller or release an original resource.
    pub fn assert_current(&mut self) -> std::result::Result<(), FleetMaintenanceCheckError> {
        if let Some(cause) = &self.owner.primary {
            return Err(FleetMaintenanceCheckError::retained(cause));
        }
        let body = self
            .owner
            .assert_qualified_native()
            .and_then(|()| self.owner.check_viewer())
            .and_then(|()| self.owner.assert_qualified_native())
            .and_then(|()| self.owner.assert_viewer_live());
        self.owner.retain_check(body)
    }
    /// Release only these known frame/query components, without claiming
    /// shared B-origin closure or any installation/resource effect.
    pub fn close(self) -> Result<FleetPreviewClosed, Box<FleetPreviewFailure<'a>>> {
        Box::new(FleetPreviewFailure { owner: self.owner }).close()
    }
}
