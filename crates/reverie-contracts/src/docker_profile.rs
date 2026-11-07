//! Fixed Docker base-profile derivative. Bytes are build data, never authority.
use crate::legacy_json::{self, Node, Text, Value};
use std::fmt;

pub const MAX_PROFILE_BYTES: usize = 65_536;
const RULE: &[u8] = br#"{"names":["clone","unshare","setns","mount","umount2","pivot_root","open_tree","move_mount","fsopen","fsconfig","fsmount","fspick","mount_setattr","sethostname","setdomainname","mknod","mknodat"],"action":"SCMP_ACT_ALLOW"}"#;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DockerProfileError {
    Json,
    DefaultDeny,
    Syscalls,
    Bound,
}
impl fmt::Display for DockerProfileError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::Json => "DOCKER_PROFILE_JSON",
            Self::DefaultDeny => "DOCKER_PROFILE_DEFAULT_DENY_REQUIRED",
            Self::Syscalls => "DOCKER_PROFILE_SYSCALL_LIST_REQUIRED",
            Self::Bound => "DOCKER_PROFILE_BOUND",
        })
    }
}
impl std::error::Error for DockerProfileError {}
fn key(text: &str) -> Text {
    Text(text.chars().map(u32::from).collect())
}
/// Preserve all upstream fields and append exactly the original namespace rule.
/// The pinned build input is UTF-8 text; use Python's string JSON semantics,
/// including last-key-wins, rather than byte-input encoding autodetection.
pub fn produce_docker_profile(raw: &[u8]) -> Result<Vec<u8>, DockerProfileError> {
    if raw.len() > MAX_PROFILE_BYTES {
        return Err(DockerProfileError::Bound);
    }
    let mut value =
        legacy_json::decode_engine_inventory(raw).map_err(|_| DockerProfileError::Json)?;
    let Node::Object(fields) = &mut value.0 else {
        return Err(DockerProfileError::DefaultDeny);
    };
    let expected = Value(Node::String(key("SCMP_ACT_ERRNO")));
    if !fields
        .get(&key("defaultAction"))
        .is_some_and(|action| action.python_eq(&expected))
    {
        return Err(DockerProfileError::DefaultDeny);
    }
    let Some(Value(Node::Array(rules))) = fields.get_mut(&key("syscalls")) else {
        return Err(DockerProfileError::Syscalls);
    };
    rules.push(legacy_json::decode_utf8(RULE).expect("fixed namespace rule JSON"));
    let mut bytes = crate::worker_config::encode_data(&value);
    bytes.push(b'\n');
    if bytes.len() > MAX_PROFILE_BYTES {
        return Err(DockerProfileError::Bound);
    }
    Ok(bytes)
}
