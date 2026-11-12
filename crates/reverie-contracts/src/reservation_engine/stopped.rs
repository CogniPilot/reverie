use super::*;
pub struct StoppedState {
    state: Value,
    ordinary: InventoryDigest,
}
impl StoppedState {
    /// Validate the ordinary census row before issuing the fresh stopped query.
    pub fn validate_ordinary(ordinary: &ContainerRow) -> Result<()> {
        let state = ordinary.state().map_err(|_| EngineDataError::StoppedRow)?;
        if state.len() != 2
            || !matches!(field(state, "Running"), Some(Value(Node::Bool(false))))
            || !matches!(field(state,"Pid"),Some(Value(Node::Number(Number::Integer(value)))) if value=="0")
        {
            return Err(EngineDataError::StoppedRow);
        }
        Ok(())
    }
    pub fn capture(ordinary: &ContainerRow, stdout: &str) -> Result<Self> {
        Self::validate_ordinary(ordinary)?;
        if stdout.len() > MAX_NATIVE_BYTES || splitlines(stdout).len() != 1 {
            return Err(EngineDataError::StoppedObservation);
        }
        let mut observed = legacy_json::decode_engine_stopped(stdout.as_bytes())
            .map_err(|_| EngineDataError::Json)?;
        let root = object(&observed).map_err(|_| EngineDataError::StoppedObservation)?;
        let state = object(field(root, "State").ok_or(EngineDataError::StoppedObservation)?)
            .map_err(|_| EngineDataError::StoppedObservation)?;
        if state.len() != 7
            || ![
                "Running",
                "Pid",
                "Status",
                "StartedAt",
                "Paused",
                "Restarting",
                "Dead",
            ]
            .iter()
            .all(|name| field(state, name).is_some())
        {
            return Err(EngineDataError::StoppedObservation);
        }
        if !["Running", "Paused", "Restarting", "Dead"]
            .iter()
            .all(|name| matches!(field(state, name), Some(Value(Node::Bool(_)))))
            || !matches!(
                field(state, "Pid"),
                Some(Value(Node::Number(Number::Integer(_))))
            )
        {
            return Err(EngineDataError::StoppedObservation);
        }
        let projection = ["Running", "Pid"]
            .into_iter()
            .map(|name| {
                (
                    key(name),
                    field(state, name)
                        .expect("checked stopped field")
                        .deep_clone(),
                )
            })
            .collect();
        let Node::Object(root) = &mut observed.0 else {
            unreachable!("checked root");
        };
        let state = root
            .insert(key("State"), Value(Node::Object(projection)))
            .expect("checked state");
        sorted_mounts(&mut observed)?;
        if digest(&observed)? != ordinary.snapshot_digest()? {
            return Err(EngineDataError::StoppedChanged);
        }
        Ok(Self {
            state,
            ordinary: ordinary.snapshot_digest()?,
        })
    }
    /// Checked source classification DATA, bound to the complete original row.
    /// A running, paused, restarting or changed row cannot use future paths.
    pub fn permits_future_mount_source(&self, ordinary: &ContainerRow) -> Result<bool> {
        Ok(self.ordinary == ordinary.snapshot_digest()?
            && !self.flag(StoppedFlag::Running)
            && !self.flag(StoppedFlag::Paused)
            && !self.flag(StoppedFlag::Restarting)
            && !self.flag(StoppedFlag::Dead)
            && (self.status_is("created") || self.status_is("exited")))
    }
    pub fn status_is(&self, value: &str) -> bool {
        text(field(
            object(&self.state).expect("checked stopped state"),
            "Status",
        ))
        .is_some_and(|text| text.equals_ascii(value))
    }
    pub fn started_at(&self) -> Option<MetadataText> {
        text(field(
            object(&self.state).expect("checked stopped state"),
            "StartedAt",
        ))
        .cloned()
        .map(MetadataText::from_text)
    }
    pub fn flag(&self, flag: StoppedFlag) -> bool {
        let name = match flag {
            StoppedFlag::Running => "Running",
            StoppedFlag::Paused => "Paused",
            StoppedFlag::Restarting => "Restarting",
            StoppedFlag::Dead => "Dead",
        };
        matches!(
            field(object(&self.state).expect("checked stopped state"), name),
            Some(Value(Node::Bool(true)))
        )
    }
    /// Exact returned state DATA, which can contain exponent-overflow extras;
    /// this is neither a successful stop receipt nor a journal transition.
    pub fn state_bytes(&self) -> Vec<u8> {
        crate::worker_config::compact_data(&self.state)
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoppedFlag {
    Running,
    Paused,
    Restarting,
    Dead,
}
