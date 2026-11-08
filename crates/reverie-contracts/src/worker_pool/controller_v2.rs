//! Bootstrap observations and immutable birth-document DATA. Neither decoding
//! nor a matching PID/digest supplies maintenance, process or effect authority.
use super::*;
use crate::resource_actor::CodeFile;
use reverie_core::{PythonText, operations::JournalDigest};
#[cfg(test)]
mod tests;

pub const SERVICE_PURPOSE: &str = "reverie-docker-worker-controller-v2";
const PROGRAM_PURPOSE: &str = "reverie-native-worker-broker-v1";

#[derive(Clone, Eq, PartialEq)]
pub struct BrokerProgramData {
    code: CodeFile,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProgramDocument {
    version: u32,
    purpose: String,
    executable: String,
    executable_sha256: String,
    bytes: u64,
}
impl BrokerProgramData {
    pub fn decode(raw: &[u8]) -> Result<Self, PoolPolicyError> {
        if raw.is_empty() || raw.len() > 8192 {
            return Err(PoolPolicyError);
        }
        Self::checked(serde_json::from_slice(raw).map_err(|_| PoolPolicyError)?)
    }
    fn checked(value: ProgramDocument) -> Result<Self, PoolPolicyError> {
        let parts: Vec<_> = value.executable.split('/').collect();
        if value.version != 1
            || value.purpose != PROGRAM_PURPOSE
            || parts.len() != 6
            || parts[..3] != ["", "nix", "store"]
            || parts[3].is_empty()
            || parts[3] == "."
            || parts[3] == ".."
            || parts[4..] != ["bin", "reverie-worker-broker"]
            || value.executable.contains('\0')
            || !(1..=256 * 1024 * 1024).contains(&value.bytes)
        {
            return Err(PoolPolicyError);
        }
        Ok(Self {
            code: CodeFile {
                path: PythonText::from_scalar_text(&value.executable),
                sha256: JournalDigest::parse(&value.executable_sha256)
                    .map_err(|_| PoolPolicyError)?,
                bytes: value.bytes,
            },
        })
    }
    pub fn code(&self) -> &CodeFile {
        &self.code
    }
    fn document(&self) -> ProgramDocument {
        ProgramDocument {
            version: 1,
            purpose: PROGRAM_PURPOSE.into(),
            executable: self.code.path.scalar_text().expect("scalar path"),
            executable_sha256: self.code.sha256.as_str().into(),
            bytes: self.code.bytes,
        }
    }
}

/// A serialization of actual bootstrap observations, not the retained PIDFD or
/// qualified process owner. Only the native bootstrap may delegate that owner.
#[derive(Clone, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BrokerBirthData {
    pid: u32,
    start: String,
    uid: u32,
    gid: u32,
    executable: [u64; 2],
    namespaces: [u64; 3],
    argv_sha256: String,
}
impl BrokerBirthData {
    pub fn from_observations(
        pid: u32,
        start: String,
        ids: [u32; 2],
        executable: [u64; 2],
        namespaces: [u64; 3],
        argv_sha256: String,
    ) -> Result<Self, PoolPolicyError> {
        let value = Self {
            pid,
            start,
            uid: ids[0],
            gid: ids[1],
            executable,
            namespaces,
            argv_sha256,
        };
        value.validate()?;
        Ok(value)
    }
    fn validate(&self) -> Result<(), PoolPolicyError> {
        if self.pid <= 1
            || self.uid == 0
            || self.gid == 0
            || self
                .start
                .parse::<u64>()
                .ok()
                .is_none_or(|value| value == 0)
            || self.start.starts_with('0')
            || self.executable[1] == 0
            || self.namespaces.contains(&0)
            || JournalDigest::parse(&self.argv_sha256).is_err()
        {
            return Err(PoolPolicyError);
        }
        Ok(())
    }
    pub fn pid(&self) -> u32 {
        self.pid
    }
    pub fn start(&self) -> &str {
        &self.start
    }
    pub fn ids(&self) -> [u32; 2] {
        [self.uid, self.gid]
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct ControllerBirthV2 {
    policy: WorkerPoolPolicy,
    broker: BrokerBirthData,
    program: BrokerProgramData,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BirthDocument {
    version: u32,
    purpose: String,
    policy: WorkerPoolPolicy,
    broker: BrokerBirthData,
    program: ProgramDocument,
}
impl ControllerBirthV2 {
    pub fn from_observations(
        policy: WorkerPoolPolicy,
        broker: BrokerBirthData,
        program: BrokerProgramData,
    ) -> Result<Self, PoolPolicyError> {
        policy.validate()?;
        broker.validate()?;
        if broker.ids() != [policy.broker_uid, policy.broker_gid] {
            return Err(PoolPolicyError);
        }
        Ok(Self {
            policy,
            broker,
            program,
        })
    }
    pub fn decode(raw: &[u8]) -> Result<Self, PoolPolicyError> {
        if raw.is_empty() || raw.len() > 65_536 {
            return Err(PoolPolicyError);
        }
        let value: BirthDocument = serde_json::from_slice(raw).map_err(|_| PoolPolicyError)?;
        if value.version != 2 || value.purpose != SERVICE_PURPOSE {
            return Err(PoolPolicyError);
        }
        Self::from_observations(
            value.policy,
            value.broker,
            BrokerProgramData::checked(value.program)?,
        )
    }
    pub fn encode(&self) -> Result<Vec<u8>, PoolPolicyError> {
        let raw = serde_json::to_vec(&BirthDocument {
            version: 2,
            purpose: SERVICE_PURPOSE.into(),
            policy: self.policy.clone(),
            broker: self.broker.clone(),
            program: self.program.document(),
        })
        .map_err(|_| PoolPolicyError)?;
        if raw.len() > 65_536 {
            return Err(PoolPolicyError);
        }
        Ok(raw)
    }
    pub fn policy(&self) -> &WorkerPoolPolicy {
        &self.policy
    }
    pub fn broker(&self) -> &BrokerBirthData {
        &self.broker
    }
    pub fn program(&self) -> &BrokerProgramData {
        &self.program
    }
}
