//! Broker request and immutable container argv preparation data. Successful
//! decoding/preparation is not peer admission, storage custody or start authority.
mod create;
mod created;
mod helpers;
mod network;
mod pane;
mod request;
mod terminal;
mod viewer;
pub use create::{CreateArguments, CreateObservations, CreatePreparation, create_arguments};
pub use created::{CreatedState, CreatedStateError};
pub(crate) use helpers::dead_pane_recheck;
pub use helpers::{LaunchSettings, employee_hostname, temporary_environment, tmux_exec_args};
pub use network::{NetworkDataError, assert_network_labels};
pub use pane::{pane_start_arguments, pane_status_arguments, runtime_metadata};
pub use viewer::{viewer_attach_arguments, viewer_marker_entry};
pub fn account_mount_arguments(entries: &[(MetadataText, MetadataText)]) -> Vec<MetadataText> {
    entries
        .iter()
        .flat_map(|(destination, source)| {
            [
                MetadataText::from_scalar_text("--mount"),
                create::bind(source, destination, false),
            ]
        })
        .collect()
}
pub fn account_destination(
    selection: &reverie_core::worker_launch::AccountSelection,
) -> MetadataText {
    MetadataText::from_text(Text(selection.destination().to_vec()))
}
pub fn resolved_account_source(source: &reverie_core::posix_path::PosixPath) -> MetadataText {
    MetadataText::from_text(Text(source.codepoints()))
}
pub fn storage_path_text(points: &[u32]) -> Result<MetadataText> {
    if points.iter().any(|&cp| cp > 0x10ffff) {
        return Err(LaunchDataError::Configuration);
    }
    Ok(MetadataText::from_text(Text(points.to_vec())))
}
use crate::legacy_json::{Node, Number, Text, Value};
use crate::storage_identity::MetadataText;
use crate::worker_config::EffectiveWorkerConfig;
pub(crate) use request::RequestField;
pub use request::{MAX_REQUEST_FRAME, WorkerRequest};
use reverie_core::worker_launch::LaunchRuleError;
use std::{collections::BTreeMap, fmt};
pub use terminal::{
    ExitReceiptDecoder, ExitReceiptError, TerminalFrame, TerminalFrameError, ViewerClient,
    decode_terminal_frame, viewer_clients,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchDataError {
    Json,
    Frame,
    Request,
    Session,
    Attach,
    Rule(LaunchRuleError),
    Configuration,
    Employee,
}
impl fmt::Display for LaunchDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(out, "{self:?}")
    }
}
impl std::error::Error for LaunchDataError {}
impl From<LaunchRuleError> for LaunchDataError {
    fn from(error: LaunchRuleError) -> Self {
        Self::Rule(error)
    }
}
type Result<T> = std::result::Result<T, LaunchDataError>;
type Object = BTreeMap<Text, Value>;
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn field<'a>(object: &'a Object, name: &str) -> Option<&'a Value> {
    object.get(&key(name))
}
fn object(value: &Value) -> Result<&Object> {
    match &value.0 {
        Node::Object(value) => Ok(value),
        _ => Err(LaunchDataError::Configuration),
    }
}
fn text(value: Option<&Value>) -> Result<&Text> {
    match value {
        Some(Value(Node::String(value))) => Ok(value),
        _ => Err(LaunchDataError::Configuration),
    }
}
fn scalar(value: Option<&Value>) -> Result<String> {
    text(value)?
        .0
        .iter()
        .map(|&cp| char::from_u32(cp))
        .collect::<Option<_>>()
        .ok_or(LaunchDataError::Configuration)
}
fn integer(value: Option<&Value>) -> Result<u64> {
    match value {
        Some(Value(Node::Number(Number::Integer(value)))) => {
            value.parse().map_err(|_| LaunchDataError::Configuration)
        }
        _ => Err(LaunchDataError::Configuration),
    }
}
/// Validated upstream mount declarations, preserving their raw spelling/order.
/// Derived readonly lease mounts are included without rerunning base mount bans.
pub struct LaunchMount {
    source: MetadataText,
    destination: MetadataText,
    read_only: bool,
}
impl LaunchMount {
    pub fn source(&self) -> &MetadataText {
        &self.source
    }
    pub fn destination(&self) -> &MetadataText {
        &self.destination
    }
    pub fn read_only(&self) -> bool {
        self.read_only
    }
}
pub fn mounts(config: &EffectiveWorkerConfig) -> Result<Vec<LaunchMount>> {
    let Some(Value(Node::Array(values))) = field(object(config.as_value())?, "mounts") else {
        return Err(LaunchDataError::Configuration);
    };
    values
        .iter()
        .map(|value| {
            let entry = object(value)?;
            let Some(Value(Node::Bool(read_only))) = field(entry, "readOnly") else {
                return Err(LaunchDataError::Configuration);
            };
            Ok(LaunchMount {
                source: MetadataText::from_text(text(field(entry, "source"))?.clone()),
                destination: MetadataText::from_text(text(field(entry, "destination"))?.clone()),
                read_only: *read_only,
            })
        })
        .collect()
}
/// The original exact-string alias decision, independent of path resolution.
pub fn workspace_alias(mounts: &[LaunchMount]) -> Option<&LaunchMount> {
    let ascii = |value: &MetadataText, expected: &str| {
        value
            .codepoints()
            .iter()
            .copied()
            .eq(expected.bytes().map(u32::from))
    };
    let shared: Vec<_> = mounts
        .iter()
        .filter(|mount| ascii(mount.destination(), "/reverie_workspace"))
        .collect();
    let occupied = mounts.iter().any(|mount| {
        ascii(mount.destination(), "/workspace")
            || mount
                .destination()
                .codepoints()
                .starts_with(&"/workspace/".bytes().map(u32::from).collect::<Vec<_>>())
    });
    if shared.len() == 1 && !occupied {
        Some(shared[0])
    } else {
        None
    }
}
