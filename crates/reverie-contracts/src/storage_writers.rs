//! Broker.check_storage_writers DATA phases. This is not reservation inventory,
//! a native writer-exclusion lease, an authorization grant or a start permit.
mod wait_binding;
use crate::{
    legacy_json::{self, Node, Text, Value},
    reservation_engine::StoragePathText,
    storage_identity::MetadataText,
};
use reverie_core::{
    ids::{ContainerId, ProfileSessionId},
    posix_path::PosixPath,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};
pub use wait_binding::{LaunchWaitBinding, launch_wait_binding};
type Object = BTreeMap<Text, Value>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WriterDataError {
    Ids,
    Json,
    Inventory,
    Structure,
    State,
    CanonicalStorage,
    CompetingWriter,
    WaitBinding,
}
impl WriterDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Ids => "WORKER_STORAGE_WRITER_IDS",
            Self::Json => "WORKER_STORAGE_WRITER_JSON",
            Self::Inventory => "WORKER_STORAGE_WRITER_INVENTORY",
            Self::Structure => "WORKER_STORAGE_WRITER_STRUCTURE",
            Self::State => "WORKER_STORAGE_WRITER_STATE",
            Self::CanonicalStorage => "WORKER_CANONICAL_STORAGE_RECREATE",
            Self::CompetingWriter => "WORKER_COMPETING_STORAGE_WRITER",
            Self::WaitBinding => "WORKER_LAUNCH_WAIT_BINDING",
        }
    }
}
impl fmt::Display for WriterDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for WriterDataError {}
type Result<T> = std::result::Result<T, WriterDataError>;
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn object(value: &Value) -> Result<&Object> {
    if let Node::Object(value) = &value.0 {
        Ok(value)
    } else {
        Err(WriterDataError::Structure)
    }
}
fn field<'a>(value: &'a Object, name: &str) -> Option<&'a Value> {
    value.get(&key(name))
}
fn optional_object(value: Option<&Value>) -> Result<Option<&Object>> {
    value.map(object).transpose()
}
fn text_is(value: Option<&Value>, expected: &str) -> bool {
    matches!(value,Some(Value(Node::String(value))) if value.equals_ascii(expected))
}
fn path_is(value: Option<&Value>, expected: &PosixPath) -> bool {
    matches!(value,Some(Value(Node::String(value))) if value.0==expected.codepoints())
}
fn hashable(value: Option<&Value>) -> bool {
    !matches!(value, Some(Value(Node::Array(_) | Node::Object(_))))
}
/// Validated output of the distinct running-only ps query; zero CID is accepted.
pub struct WriterIds(Vec<ContainerId>);
impl WriterIds {
    pub fn decode(stdout: &str) -> Result<Self> {
        let parts = stdout
            .split(|ch| crate::kernel_mounts::python_space(u32::from(ch)))
            .filter(|word| !word.is_empty())
            .collect::<Vec<_>>();
        if parts.len() > 128 || parts.iter().copied().collect::<BTreeSet<_>>().len() != parts.len()
        {
            return Err(WriterDataError::Ids);
        }
        parts
            .into_iter()
            .map(|part| ContainerId::parse(part).map_err(|_| WriterDataError::Ids))
            .collect::<Result<Vec<_>>>()
            .map(Self)
    }
    pub fn ids(&self) -> &[ContainerId] {
        &self.0
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}
/// Complete parsed inspect data. Duplicate returned rows remain source-accepted
/// when the returned ID SET matches; no PID/strict-Mounts/finite-extra gate added.
pub struct WriterInventory(Value);
impl WriterInventory {
    pub fn decode(raw: &[u8], expected: &WriterIds) -> Result<Self> {
        let value = legacy_json::decode_python_str(raw).map_err(|_| WriterDataError::Json)?;
        let Node::Array(rows) = &value.0 else {
            return Err(WriterDataError::Inventory);
        };
        let mut returned = BTreeSet::new();
        let mut other = false;
        for row in rows {
            let id = field(object(row)?, "Id");
            if !hashable(id) {
                return Err(WriterDataError::Structure);
            }
            if let Some(Value(Node::String(id))) = id {
                returned.insert(id.clone());
            } else {
                other = true;
            }
        }
        let wanted = expected
            .ids()
            .iter()
            .map(|id| key(id.as_str()))
            .collect::<BTreeSet<_>>();
        if other || returned != wanted {
            return Err(WriterDataError::Inventory);
        }
        Ok(Self(value))
    }
    pub fn len(&self) -> usize {
        match &self.0.0 {
            Node::Array(rows) => rows.len(),
            _ => unreachable!("array invariant"),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn row<'a>(
        &'a self,
        index: usize,
        selection: WriterSelection<'a>,
    ) -> Result<WriterMounts<'a>> {
        let Node::Array(rows) = &self.0.0 else {
            unreachable!("array invariant")
        };
        let row = object(rows.get(index).ok_or(WriterDataError::Structure)?)?;
        let state = optional_object(field(row, "State"))?;
        if !matches!(
            state.and_then(|state| field(state, "Running")),
            Some(Value(Node::Bool(true)))
        ) {
            return Err(WriterDataError::State);
        }
        let config = optional_object(field(row, "Config"))?;
        let labels = config.and_then(|config| field(config, "Labels"));
        let labels = if legacy_json::truthy(labels) {
            Some(labels.expect("truthy value"))
        } else {
            None
        };
        let name = format!(
            "/{}-agent-{}",
            selection.deployment,
            selection.session.as_str()
        );
        let named = text_is(field(row, "Name"), &name);
        // Falsy labels become {}, but truthy non-object labels are consulted
        // ONLY for the named row, preserving Python's own-expression short circuit.
        let own = if named {
            let labels = optional_object(labels)?;
            text_is(
                labels.and_then(|v| field(v, "reverie.worker")),
                selection.deployment,
            ) && text_is(
                labels.and_then(|v| field(v, "reverie.session")),
                selection.session.as_str(),
            ) && text_is(
                labels.and_then(|v| field(v, "reverie.employee")),
                selection.identity,
            )
        } else {
            false
        };
        let mounts = iterable(field(row, "Mounts"))?;
        let mut selected = Vec::new();
        let mut home = false;
        let mut nix = false;
        // Build/check the WHOLE raw writable-bind tuple set before native path
        // resolution begins. Its non-string scalar members may remain hashable.
        for mount in mounts {
            let mount = object(mount)?;
            if !writable(mount) {
                continue;
            }
            let source = field(mount, "Source");
            let target = field(mount, "Destination");
            if !hashable(source) || !hashable(target) {
                return Err(WriterDataError::Structure);
            }
            home |= path_is(source, selection.paths.home()) && text_is(target, "/home/agent");
            nix |= path_is(source, selection.paths.nix()) && text_is(target, "/nix");
            selected.push(mount);
        }
        if named && (!own || !home || !nix) {
            return Err(WriterDataError::CanonicalStorage);
        }
        Ok(WriterMounts {
            selection,
            own,
            mounts: selected,
        })
    }
}
fn iterable(value: Option<&Value>) -> Result<&[Value]> {
    match value {
        None => Ok(&[]),
        Some(Value(Node::Array(rows))) => Ok(rows),
        Some(Value(Node::Object(rows))) if rows.is_empty() => Ok(&[]),
        Some(Value(Node::String(value))) if value.0.is_empty() => Ok(&[]),
        _ => Err(WriterDataError::Structure),
    }
}
fn writable(value: &Object) -> bool {
    text_is(field(value, "Type"), "bind")
        && matches!(field(value, "RW"), Some(Value(Node::Bool(true))))
}
/// Caller-selected expected DATA, not an authority/custody constructor.
#[derive(Clone, Copy)]
pub struct WriterSelection<'a> {
    pub deployment: &'a str,
    pub session: &'a ProfileSessionId,
    pub identity: &'a str,
    pub paths: &'a StoragePathText,
}
pub struct WriterMounts<'a> {
    selection: WriterSelection<'a>,
    own: bool,
    mounts: Vec<&'a Object>,
}
pub struct WritableMount<'a> {
    selection: WriterSelection<'a>,
    own: bool,
    value: &'a Object,
}
impl<'a> WriterMounts<'a> {
    pub fn mounts(&self) -> impl Iterator<Item = WritableMount<'a>> + '_ {
        self.mounts.iter().map(|&value| WritableMount {
            selection: self.selection,
            own: self.own,
            value,
        })
    }
}
impl WritableMount<'_> {
    pub fn source(&self) -> Result<MetadataText> {
        match field(self.value, "Source") {
            Some(Value(Node::String(value))) => Ok(MetadataText::from_text(value.clone())),
            _ => Err(WriterDataError::Structure),
        }
    }
    /// Resolved path is DATA. The host must perform the actual source-ordered
    /// non-strict resolution before this pure comparison; no proof is minted.
    pub fn check_resolved(&self, resolved: &PosixPath) -> Result<()> {
        let roots = [self.selection.paths.home(), self.selection.paths.nix()];
        let overlap = roots.iter().any(|root| resolved.overlaps(root));
        let exact = self.own
            && ((resolved == roots[0] && text_is(field(self.value, "Destination"), "/home/agent"))
                || (resolved == roots[1] && text_is(field(self.value, "Destination"), "/nix")));
        if overlap && !exact {
            Err(WriterDataError::CompetingWriter)
        } else {
            Ok(())
        }
    }
}
