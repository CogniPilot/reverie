//! J's first inspect phase: Config/Labels precede Running even for a stopped
//! row. This is observation DATA; labels and a canonical ID grant no effects.
use super::*;
use reverie_core::{decimal::UnsignedInteger, ids::ContainerId};

pub struct LaunchLaptopInspection(Value);
impl LaunchLaptopInspection {
    /// Exact-int positive PID declaration DATA, without observing /proc or
    /// inventing an actual process incarnation from the reply.
    pub fn positive_process_id(&self) -> Result<UnsignedInteger, LaptopReadError> {
        let Value(Node::Number(crate::legacy_json::Number::Integer(raw))) =
            field(field(&self.0, "State")?, "Pid")?
        else {
            return Err(LaptopReadError::Process);
        };
        UnsignedInteger::parse(raw)
            .filter(|pid| !pid.is_zero())
            .ok_or(LaptopReadError::Process)
    }
    pub fn require_id_field(&self) -> Result<(), LaptopReadError> {
        field(&self.0, "Id").map(|_| ())
    }
    /// Parse all returned JSON, consume only [0], and perform the original
    /// ownership-label check before any State, runtime-file or pane lookup.
    pub fn decode_owned(
        stdout: &[u8],
        deployment: &str,
        session: &ProfileSessionId,
    ) -> Result<Self, LaptopReadError> {
        let row = first(stdout)?;
        let labels = field(field(&row, "Config")?, "Labels")?;
        let Node::Object(labels) = &labels.0 else {
            // Unlike reload, launch calls .get directly, with no `or {}`.
            return Err(LaptopReadError::Structure);
        };
        if !label(Some(labels), "reverie.worker", deployment)
            || !label(Some(labels), "reverie.session", session.as_str())
        {
            return Err(LaptopReadError::Ownership);
        }
        Ok(Self(row))
    }
    pub fn running(&self) -> Result<bool, LaptopReadError> {
        Ok(legacy_json::truthy(Some(field(
            field(&self.0, "State")?,
            "Running",
        )?)))
    }
    /// A viewer hint only. Missing/noncanonical Id is allowed at this phase;
    /// a later exact native effect must establish its own real custody.
    pub fn canonical_id(&self) -> Option<ContainerId> {
        let Value(Node::String(text)) = field(&self.0, "Id").ok()? else {
            return None;
        };
        let scalar = text
            .0
            .iter()
            .copied()
            .map(char::from_u32)
            .collect::<Option<String>>()?;
        ContainerId::parse(&scalar).ok()
    }
    /// The actual launch calls this only inside the running branch, before
    /// employee-memory verification, runtime.json or an exit-file observation.
    pub fn assert_running_policy(
        &self,
        wanted: &WorkerPolicyDigest,
    ) -> Result<(), LaptopReadError> {
        let Node::Object(labels) = &field(field(&self.0, "Config")?, "Labels")?.0 else {
            return Err(LaptopReadError::Structure);
        };
        RunningLaptop {
            labels: Some(labels),
        }
        .assert_policy(wanted)
    }
}
