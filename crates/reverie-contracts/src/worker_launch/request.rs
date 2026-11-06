use super::*;
use crate::legacy_json::{self, ordered::OrderNode};
use reverie_core::{
    ids::ProfileSessionId,
    posix_path::PosixPath,
    worker_launch::{
        EnvironmentKey, TerminalSize, WorkerCommand, WorkerDirectory, WorkerEnvironment,
    },
};

pub const MAX_REQUEST_FRAME: usize = 256 * 1024;
/// Complete request validation against captured declaration DATA. This does not
/// prove that the peer/session is admitted or any filesystem grant still holds.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerRequest {
    session: ProfileSessionId,
    directory: WorkerDirectory,
    command: WorkerCommand,
    environment: WorkerEnvironment,
    terminal: TerminalSize,
    attach_only: Option<bool>,
}
impl WorkerRequest {
    pub fn decode(raw: &[u8], configuration: &EffectiveWorkerConfig) -> Result<Self> {
        if raw.len() > MAX_REQUEST_FRAME {
            return Err(LaunchDataError::Frame);
        }
        let request =
            legacy_json::decode_worker_request_bytes(raw).map_err(|_| LaunchDataError::Json)?;
        let fields = object(&request.value).map_err(|_| LaunchDataError::Request)?;
        const REQUIRED: [&str; 6] = ["sessionId", "cwd", "command", "env", "cols", "rows"];
        if REQUIRED.iter().any(|name| field(fields, name).is_none())
            || fields.keys().any(|name| {
                !REQUIRED
                    .iter()
                    .chain(["attachOnly"].iter())
                    .any(|expected| name.equals_ascii(expected))
            })
        {
            return Err(LaunchDataError::Request);
        }
        let session = ProfileSessionId::parse(
            &scalar(field(fields, "sessionId")).map_err(|_| LaunchDataError::Session)?,
        )
        .map_err(|_| LaunchDataError::Session)?;
        let attach_only = match field(fields, "attachOnly") {
            None => None,
            Some(Value(Node::Bool(value))) => Some(*value),
            _ => return Err(LaunchDataError::Attach),
        };
        let directory = WorkerDirectory::try_new(
            text(field(fields, "cwd"))
                .map_err(|_| LaunchRuleError::Directory)?
                .0
                .clone(),
        )?;
        writable(&directory, configuration)?;
        let command = WorkerCommand::try_new(
            text(field(fields, "command"))
                .map_err(|_| LaunchRuleError::Command)?
                .0
                .clone(),
        )?;
        let environment = environment(&request, fields)?;
        let terminal =
            TerminalSize::try_new(dimension(fields, "cols")?, dimension(fields, "rows")?)?;
        Ok(Self {
            session,
            directory,
            command,
            environment,
            terminal,
            attach_only,
        })
    }
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
    pub fn directory(&self) -> &WorkerDirectory {
        &self.directory
    }
    pub fn command(&self) -> &WorkerCommand {
        &self.command
    }
    pub fn environment(&self) -> &WorkerEnvironment {
        &self.environment
    }
    pub fn terminal(&self) -> TerminalSize {
        self.terminal
    }
    pub fn attach_only(&self) -> Option<bool> {
        self.attach_only
    }
}
fn writable(directory: &WorkerDirectory, config: &EffectiveWorkerConfig) -> Result<()> {
    let mounts = mounts(config)?;
    let mut roots = mounts
        .iter()
        .filter(|mount| !mount.read_only())
        .map(|mount| {
            PosixPath::try_new(mount.destination().codepoints())
                .map_err(|_| LaunchDataError::Configuration)
        })
        .collect::<Result<Vec<_>>>()?;
    if workspace_alias(&mounts).is_some_and(|alias| !alias.read_only()) {
        roots.push(PosixPath::from_scalar_text("/workspace"));
    }
    Ok(directory.require_writable(&roots)?)
}
fn environment(
    request: &legacy_json::ordered::OrderedValue,
    fields: &Object,
) -> Result<WorkerEnvironment> {
    let values = object(field(fields, "env").expect("required key"))
        .map_err(|_| LaunchRuleError::Environment)?;
    let index = request
        .root_child_index(&key("env"))
        .expect("decoded key order");
    let OrderNode::Object(order) = &request.graph.nodes[index] else {
        return Err(LaunchRuleError::Environment.into());
    };
    let entries = order
        .iter()
        .map(|(name, _)| {
            let name = name
                .0
                .iter()
                .map(|&cp| char::from_u32(cp))
                .collect::<Option<String>>()
                .ok_or(LaunchRuleError::Environment)?;
            let name = EnvironmentKey::parse(&name)?;
            let value =
                text(values.get(&key(name.as_str()))).map_err(|_| LaunchRuleError::Environment)?;
            Ok((name, value.0.clone()))
        })
        .collect::<Result<_>>()?;
    Ok(WorkerEnvironment::try_new(entries)?)
}
fn dimension(fields: &Object, name: &str) -> Result<u16> {
    integer(field(fields, name))
        .ok()
        .and_then(|number| u16::try_from(number).ok())
        .ok_or(LaunchRuleError::Terminal.into())
}
