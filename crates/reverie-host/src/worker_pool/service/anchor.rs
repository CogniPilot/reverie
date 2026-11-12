//! One original fixed Docker anchor attempt. Raw create reply and immutable
//! CID are retained before subsequent fallible native observations.
use super::*;
use reverie_contracts::worker_pool::RetainedPoolAnchor;

#[derive(Default)]
pub(super) struct Anchor {
    pub(super) create_attempted: bool,
    pub(super) raw_create: Option<Vec<u8>>,
    pub(super) id: Option<String>,
    pub(super) start_attempted: bool,
    pub(super) pid: u32,
    pub(super) daemon_unknown: bool,
}
impl Anchor {
    pub(super) fn reopen(
        &mut self,
        policy: &ControllerPoolPolicy,
        anchor: &RetainedPoolAnchor,
        end: Instant,
    ) -> Result<()> {
        need(self.id.is_none(), "WORKER_POOL_ANCHOR_ALREADY_ATTEMPTED")?;
        check(end)?;
        policy.assert_anchor(anchor.container_id(), anchor.pid())?;
        self.id = Some(anchor.container_id().to_owned());
        self.pid = anchor.pid();
        check(end)
    }

    pub(super) fn create(&mut self, policy: &ControllerPoolPolicy, end: Instant) -> Result<()> {
        need(
            !self.create_attempted,
            "WORKER_POOL_ANCHOR_ALREADY_ATTEMPTED",
        )?;
        policy.assert_current()?;
        check(end)?;
        self.create_attempted = true;
        self.daemon_unknown = true;
        let digest = hex(policy.version_digest_data());
        self.raw_create = Some(policy.engine.create_anchor(policy.data(), &digest)?);
        let value: serde_json::Value =
            serde_json::from_slice(self.raw_create.as_ref().expect("raw stored before parse"))
                .map_err(|_| PoolError::Refused("WORKER_POOL_ANCHOR_REPLY"))?;
        self.id = Some(
            value["Id"]
                .as_str()
                .filter(|id| reverie_contracts::worker_pool::hex_id(id))
                .ok_or(PoolError::Refused("WORKER_POOL_ANCHOR_REPLY"))?
                .to_owned(),
        );
        self.daemon_unknown = false;
        check(end)?;
        self.start_attempted = true;
        self.daemon_unknown = true;
        policy
            .engine
            .start_anchor(self.id.as_deref().expect("actual created CID"))?;
        self.daemon_unknown = false;
        let raw = policy
            .engine
            .inspect(self.id.as_deref().expect("actual created CID"))?;
        let value: serde_json::Value = serde_json::from_slice(&raw)
            .map_err(|_| PoolError::Refused("WORKER_POOL_ANCHOR_INSPECTION"))?;
        self.pid = value["State"]["Pid"]
            .as_u64()
            .and_then(|pid| u32::try_from(pid).ok())
            .filter(|pid| *pid > 1)
            .ok_or(PoolError::Refused("WORKER_POOL_ANCHOR_PID"))?;
        policy.assert_anchor(self.id.as_deref().expect("actual created CID"), self.pid)?;
        check(end)
    }
}
