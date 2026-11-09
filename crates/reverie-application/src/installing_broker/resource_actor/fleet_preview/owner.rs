use super::*;
use std::time::{SystemTime, UNIX_EPOCH};
impl<'a> NativeFleetPreview<'a> {
    pub(super) fn prepare(&mut self, broker: &'a Arc<InstallingBroker>) -> Result<()> {
        if matches!(self.target, Some(TargetAttempt::Offer(None))) {
            let cause = Cause::Refused("FLEET_PREVIEW_SETUP_REQUIRED");
            let frame = self.frame.as_mut().expect("original Q retained");
            let Transport::Incoming(connection) = &frame.transport else {
                return Err(cause);
            };
            connection
                .assert_service(&broker.reports)
                .map_err(ResourceActorError::from)?;
            return match connection.report_failure(cause.code()) {
                Ok(()) => Err(cause),
                Err(error) => Err(Cause::Finalization {
                    primary: Box::new(cause),
                    secondary: Box::new(Cause::Actor(error.into())),
                }),
            };
        }
        let frame = self.frame.as_mut().expect("original Q retained");
        frame.retain()?;
        let target = self.target.as_mut().expect("original OS offer retained");
        frame.deadline = frame.deadline.min(target.capture_view(broker)?);
        target.observe()?;
        frame.prepare_after_retain()?;
        self.request = Some(FleetPreviewRequest::decode(
            &frame.receive(frame.deadline)?,
        )?);
        self.check_viewer()?;
        self.assert_binding()?;
        let frame = self.frame.as_mut().expect("same qualified Q");
        let end = frame.deadline;
        self.coverage = Some(coverage::Coverage::capture(frame, end)?);
        let binding = self.target.as_mut().expect("original target").current()?;
        self.selection = Some(
            self.coverage
                .as_ref()
                .expect("native coverage retained")
                .selection(&binding)?,
        );
        Ok(())
    }
    fn assert_binding(&mut self) -> Result<UnpreparedOfferBinding> {
        let frame = self.frame.as_ref().expect("same Q");
        let target = self.target.as_mut().expect("same target");
        target.binding(
            frame,
            self.request.as_ref().expect("actual Q request").principal(),
        )?;
        let binding = target.current()?;
        let installed = &frame
            .bindings
            .as_ref()
            .ok_or(Cause::Refused("FLEET_PREVIEW_WEBSITE_REQUIRED"))?
            .installed;
        let base = frame
            .snapshot
            .as_ref()
            .expect("bound snapshot")
            .envelope()
            .base();
        let policy = binding.policy();
        if policy.deployment != base.deployment()
            || policy.broker_uid != base.ids().uid()
            || policy.broker_gid != base.ids().gid()
            || policy.engine_id != installed.engine.id
            || policy.website_container != installed.website.container.as_str()
        {
            return Err(Cause::Refused("FLEET_PREVIEW_TARGET_BINDING_CHANGED"));
        }
        Ok(binding)
    }
    fn check_viewer(&mut self) -> Result<()> {
        let frame = self.frame.as_mut().expect("same Q");
        let end = frame.deadline.min(Instant::now() + Duration::from_secs(10));
        frame.guard_bootstrap(end)?;
        let nonce =
            reverie_host::resource_facts::fresh_owner_nonce().map_err(ResourceActorError::from)?;
        let request = self.request.as_ref().expect("actual Q request");
        frame.send(&request.owner_challenge(&nonce)?, end)?;
        let current = request.parse_owner_reply(&frame.receive(end)?, &nonce)?;
        let now = epoch()?;
        if current.expires_at_epoch_ms() <= now
            || current.expires_at_epoch_ms() > now.saturating_add(10_000)
            || self.viewer.as_ref().is_some_and(|old| {
                old.principal() != current.principal()
                    || old.scope_digest() != current.scope_digest()
            })
        {
            return Err(Cause::Refused("FLEET_PREVIEW_VIEWER_CHANGED_OR_EXPIRED"));
        }
        self.viewer = Some(current);
        Ok(())
    }
    pub(super) fn send_observed(&mut self) -> Result<()> {
        self.check_viewer()?;
        let binding = self.assert_binding()?;
        let frame = self.frame.as_mut().expect("same Q");
        let end = frame.deadline;
        self.coverage
            .as_ref()
            .expect("actual coverage")
            .assert_current(frame, end)?;
        self.check_viewer()?;
        self.assert_binding()?;
        let frame = self.frame.as_mut().expect("same Q");
        let now = epoch()?;
        let remaining = u64::try_from(
            frame
                .deadline
                .saturating_duration_since(Instant::now())
                .as_millis(),
        )
        .map_err(|_| Cause::Refused("FLEET_PREVIEW_EXPIRY"))?;
        let expires = self
            .viewer
            .as_ref()
            .expect("fresh viewer")
            .expires_at_epoch_ms()
            .min(now.saturating_add(remaining));
        if expires <= now {
            return Err(Cause::Refused("FLEET_PREVIEW_EXPIRY"));
        }
        let reply = self
            .request
            .as_ref()
            .expect("same request")
            .observed_reply(
                self.selection.as_ref().expect("native generated tuple"),
                binding.policy(),
                expires,
            )?;
        frame.send(&reply, frame.deadline)?;
        Ok(())
    }
}
fn epoch() -> Result<u64> {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Cause::Refused("FLEET_PREVIEW_CLOCK"))?
            .as_millis(),
    )
    .map_err(|_| Cause::Refused("FLEET_PREVIEW_CLOCK"))
}
