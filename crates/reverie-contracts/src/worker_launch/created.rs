//! Known state from one fixed inspect of an actual retained Created CID.
//! DATA alone never grants stop/release; the Host real effect owner is required.
use super::*;
use reverie_core::ids::ContainerId;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CreatedStateError {
    Json,
    Identity,
    State,
}
impl fmt::Display for CreatedStateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for CreatedStateError {}
pub struct CreatedState {
    running: bool,
    paused: bool,
    restarting: bool,
    dead: bool,
    zero_pid: bool,
}
impl CreatedState {
    pub fn decode(
        raw: &[u8],
        expected: &ContainerId,
    ) -> std::result::Result<Self, CreatedStateError> {
        let value =
            crate::legacy_json::decode_python_str(raw).map_err(|_| CreatedStateError::Json)?;
        let Node::Array(rows) = &value.0 else {
            return Err(CreatedStateError::Identity);
        };
        if rows.len() != 1 {
            return Err(CreatedStateError::Identity);
        }
        let row = object(&rows[0]).map_err(|_| CreatedStateError::Identity)?;
        if !matches!(field(row,"Id"),Some(Value(Node::String(value))) if value.equals_ascii(expected.as_str()))
        {
            return Err(CreatedStateError::Identity);
        }
        let state = object(field(row, "State").ok_or(CreatedStateError::State)?)
            .map_err(|_| CreatedStateError::State)?;
        let boolean = |name| match field(state, name) {
            Some(Value(Node::Bool(value))) => Ok(*value),
            _ => Err(CreatedStateError::State),
        };
        let Some(Value(Node::Number(Number::Integer(pid)))) = field(state, "Pid") else {
            return Err(CreatedStateError::State);
        };
        let digits = pid.strip_prefix('-').unwrap_or(pid);
        let zero_pid = digits.bytes().all(|digit| digit == b'0');
        if !zero_pid && pid.starts_with('-') {
            return Err(CreatedStateError::State);
        }
        let running = boolean("Running")?;
        if running == zero_pid {
            return Err(CreatedStateError::State);
        }
        Ok(Self {
            running,
            zero_pid,
            paused: boolean("Paused")?,
            restarting: boolean("Restarting")?,
            dead: boolean("Dead")?,
        })
    }
    pub fn running(&self) -> bool {
        self.running
    }
    pub fn stopped(&self) -> bool {
        !self.running && self.zero_pid && !self.paused && !self.restarting && !self.dead
    }
}
