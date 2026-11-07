//! Office power and status, the legacy `control()`: status, provider health,
//! resource reload, stop-laptops, and the website `shutdown` / `restart-website`
//! actions. Website power stops or restarts the server container on a detached
//! task after one second; it never closes the broker service.
#[cfg(test)]
mod tests;
use super::Refusal;
use reverie_contracts::{broker_control::ControlField, broker_reply::BrokerReply};
use std::{
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

/// The legacy delay before the engine call, so the reply reaches the owner.
pub const WEBSITE_DELAY: Duration = Duration::from_secs(1);
/// The legacy minimum spacing between website restarts.
pub const RESTART_SPACING: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WebsiteAction {
    /// `stop --time 20 <serverContainer>`.
    Stop,
    /// `restart --time 20 <serverContainer>`.
    Restart,
}

/// The installing broker's power effects.
pub trait PowerCore: Send + Sync {
    /// A structured OPS configuration is selected.
    fn ops_configured(&self) -> bool;
    fn maintenance_session(&self, caller: &str) -> bool;
    fn reload_resources(&self) -> Result<BrokerReply, Refusal>;
    /// `len(self.laptops)` and the verified running inventory, sorted, taken
    /// in one snapshot as the legacy status took both under its lock.
    fn inventory(&self) -> (i64, Vec<String>);
    /// The legacy `{"providerHealth": ...}` reply, empty while stopping.
    fn provider_health(&self) -> BrokerReply;
    fn stop_laptops(&self) -> Result<(), Refusal>;
    /// The optional engine call on the server container; its result is not
    /// reported, as the legacy `optional=True` call's was not.
    fn website(&self, action: WebsiteAction);
    /// The watchdog's optional status field.
    fn sweep_failures(&self) -> Option<BrokerReply>;
}

/// The legacy maintenance lock and last-maintenance time.
pub struct Power {
    core: Arc<dyn PowerCore>,
    busy: Arc<AtomicBool>,
    last: Mutex<Option<Instant>>,
    delay: Duration,
}
impl Power {
    pub fn new(core: Arc<dyn PowerCore>) -> Self {
        Self::with_delay(core, WEBSITE_DELAY)
    }
    pub(super) fn with_delay(core: Arc<dyn PowerCore>, delay: Duration) -> Self {
        Self {
            core,
            busy: Arc::new(AtomicBool::new(false)),
            // The legacy 0.0 monotonic start: the first restart is never spaced.
            last: Mutex::new(None),
            delay,
        }
    }
    /// One routed `Power{action, caller}` request, in the legacy order.
    pub fn control(
        &self,
        action: &ControlField,
        caller: Option<&ControlField>,
        now: Instant,
    ) -> Result<BrokerReply, Refusal> {
        let named = |name: &str| *action == ControlField::Text(name.into());
        if named("restart-website") && self.core.ops_configured() {
            return refuse(
                "Use the structured OPS restart with current authority, artifact and generation fences",
            );
        }
        if let Some(caller) = caller {
            let granted =
                matches!(caller, ControlField::Text(text) if self.core.maintenance_session(text));
            if !named("restart-website") || !granted {
                return refuse("This laptop has no owner-granted website maintenance permission");
            }
        }
        if named("reload-resources") {
            return self.core.reload_resources();
        }
        if named("status") {
            return Ok(self.status());
        }
        if named("provider-health") {
            return Ok(self.core.provider_health());
        }
        let website = if named("stop-laptops") {
            None
        } else if named("shutdown") {
            Some(WebsiteAction::Stop)
        } else if named("restart-website") {
            Some(WebsiteAction::Restart)
        } else {
            return refuse("Unknown office power action");
        };
        if !named("restart-website") {
            self.core.stop_laptops()?;
        }
        if let Some(website) = website {
            self.schedule(website, now)?;
        }
        let name = match website {
            None => "stop-laptops",
            Some(WebsiteAction::Stop) => "shutdown",
            Some(WebsiteAction::Restart) => "restart-website",
        };
        Ok(BrokerReply::object(vec![
            ("action", BrokerReply::string(name)),
            ("success", BrokerReply::boolean(true)),
        ]))
    }
    fn status(&self) -> BrokerReply {
        let (registered, running) = self.core.inventory();
        let mut fields = vec![
            ("runningLaptops", BrokerReply::integer(registered)),
            (
                "runningSessionIds",
                BrokerReply::array(running.iter().map(|s| BrokerReply::string(s)).collect()),
            ),
            ("offlineGraceSeconds", BrokerReply::integer(600)),
        ];
        if let Some(failures) = self.core.sweep_failures() {
            fields.push(("sweepFailures", failures));
        }
        BrokerReply::object(fields)
    }
    fn schedule(&self, website: WebsiteAction, now: Instant) -> Result<(), Refusal> {
        if self
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(Refusal::Message(
                "Website maintenance is already running".into(),
            ));
        }
        let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
        if website == WebsiteAction::Restart
            && last.is_some_and(|at| now.saturating_duration_since(at) < RESTART_SPACING)
        {
            self.busy.store(false, Ordering::Release);
            return Err(Refusal::Message(
                "Wait one minute between website restarts".into(),
            ));
        }
        let previous = last.replace(now);
        let core = self.core.clone();
        let busy = self.busy.clone();
        let delay = self.delay;
        let spawned = std::thread::Builder::new().spawn(move || {
            std::thread::sleep(delay);
            core.website(website);
            busy.store(false, Ordering::Release);
        });
        if spawned.is_err() {
            *last = previous;
            self.busy.store(false, Ordering::Release);
            return Err(Refusal::Transport);
        }
        Ok(())
    }
}
fn refuse<T>(text: &str) -> Result<T, Refusal> {
    Err(Refusal::Message(text.into()))
}
