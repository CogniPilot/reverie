//! Bounded reference observation DATA and the original sorted Python wire.
//! A report never proves absence or authorizes clear, retirement or a launch.
use super::records::{integer, text};
use super::*;

#[derive(Clone, Copy)]
pub enum ReferenceLink {
    Cwd,
    Root,
    Exe,
}
impl ReferenceLink {
    pub fn name(self) -> &'static str {
        match self {
            Self::Cwd => "cwd",
            Self::Root => "root",
            Self::Exe => "exe",
        }
    }
    fn known(self) -> &'static str {
        match self {
            Self::Cwd => "CWD_REFERENCE",
            Self::Root => "ROOT_REFERENCE",
            Self::Exe => "EXE_REFERENCE",
        }
    }
    fn unknown(self) -> &'static str {
        match self {
            Self::Cwd => "CWD_UNAVAILABLE",
            Self::Root => "ROOT_UNAVAILABLE",
            Self::Exe => "EXE_UNAVAILABLE",
        }
    }
}
#[derive(Clone, Copy)]
pub enum KnownReference {
    Fd,
    NamespaceSocket,
    Socket,
    Link(ReferenceLink),
    Mapped,
}
impl KnownReference {
    fn name(self) -> &'static str {
        match self {
            Self::Fd => "FD_REFERENCE",
            Self::NamespaceSocket => "UNIX_SOCKET_REFERENCE_IN_NAMESPACE",
            Self::Socket => "SOCKET_REFERENCE",
            Self::Link(link) => link.known(),
            Self::Mapped => "MAPPED_REFERENCE",
        }
    }
}
#[derive(Clone, Copy)]
pub enum UnknownReference {
    MountMetadata,
    FdInventory,
    FdIdentity,
    FdPath,
    FdMountMetadata,
    DetachedFdMount,
    Coordinates,
    RelativeUnixPath,
    SocketNamespace,
    SocketMetadata,
    Link(ReferenceLink),
    MapPath,
    MapInventory,
}
impl UnknownReference {
    fn name(self) -> &'static str {
        match self {
            Self::MountMetadata => "MOUNT_METADATA_UNAVAILABLE",
            Self::FdInventory => "FD_INVENTORY_UNAVAILABLE",
            Self::FdIdentity => "FD_IDENTITY_UNAVAILABLE",
            Self::FdPath => "FD_PATH_UNAVAILABLE",
            Self::FdMountMetadata => "FD_MOUNT_METADATA_UNAVAILABLE",
            Self::DetachedFdMount => "FD_MOUNT_NOT_IN_CURRENT_NAMESPACE",
            Self::Coordinates => "REFERENCE_COORDINATES_UNAVAILABLE",
            Self::RelativeUnixPath => "RELATIVE_UNIX_PATH_UNCLASSIFIED",
            Self::SocketNamespace => "SOCKET_NAMESPACE_UNCLASSIFIED",
            Self::SocketMetadata => "SOCKET_METADATA_UNAVAILABLE",
            Self::Link(link) => link.unknown(),
            Self::MapPath => "MAP_PATH_UNAVAILABLE",
            Self::MapInventory => "MAP_INVENTORY_UNAVAILABLE",
        }
    }
}
pub enum ReferenceKind {
    Known(KnownReference),
    Unknown(UnknownReference),
}
#[derive(Default)]
pub struct ReferenceReport {
    known: usize,
    unknown: usize,
    processes: usize,
    fds: usize,
    map_bytes: usize,
    unix_bytes: usize,
    known_examples: Vec<Value>,
    unknown_examples: Vec<Value>,
}
impl ReferenceReport {
    pub fn note_process(&mut self) -> Result<()> {
        add(&mut self.processes, 1, 16384)
    }
    pub fn note_fd(&mut self) -> Result<()> {
        add(&mut self.fds, 1, 262144)
    }
    pub fn note_maps(&mut self, bytes: usize) -> Result<()> {
        add(&mut self.map_bytes, bytes, 256 << 20)
    }
    pub fn note_unix(&mut self, bytes: usize) -> Result<()> {
        add(&mut self.unix_bytes, bytes, 64 << 20)
    }
    pub fn known_count(&self) -> usize {
        self.known
    }
    pub fn unknown_count(&self) -> usize {
        self.unknown
    }
    pub fn record(&mut self, pid: u32, kind: ReferenceKind) -> Result<()> {
        let (counter, examples, name, identity) = match kind {
            ReferenceKind::Known(kind) => (
                &mut self.known,
                &mut self.known_examples,
                kind.name(),
                if matches!(kind, KnownReference::NamespaceSocket) {
                    "observerPid"
                } else {
                    "pid"
                },
            ),
            ReferenceKind::Unknown(kind) => (
                &mut self.unknown,
                &mut self.unknown_examples,
                kind.name(),
                "pid",
            ),
        };
        add(counter, 1, usize::MAX)?;
        if examples.len() < 32 {
            examples.push(Value(Node::Object(BTreeMap::from([
                (key(identity), integer(u64::from(pid))),
                (key("kind"), text(name)),
            ]))));
        }
        Ok(())
    }
    /// Only the native collector's successfully completed traversal may use
    /// this DATA encoding. The fixed false fields deliberately disclaim both
    /// a deep-tree walk and proof that all possible references are absent.
    pub fn encode(&self) -> Vec<u8> {
        worker_config::encode_data(&self.value())
    }
    pub(super) fn value(&self) -> Value {
        let counts = [
            ("known", self.known),
            ("unknown", self.unknown),
            ("ownedProcesses", self.processes),
            ("fds", self.fds),
            ("mapBytes", self.map_bytes),
            ("unixBytes", self.unix_bytes),
        ]
        .into_iter()
        .map(|(name, value)| (key(name), integer(value as u64)))
        .collect();
        Value(Node::Object(BTreeMap::from([
            (
                key("knownReferences"),
                Value(Node::Array(
                    self.known_examples.iter().map(Value::deep_clone).collect(),
                )),
            ),
            (
                key("unknownReferences"),
                Value(Node::Array(
                    self.unknown_examples
                        .iter()
                        .map(Value::deep_clone)
                        .collect(),
                )),
            ),
            (key("counts"), Value(Node::Object(counts))),
            (
                key("allInitiallyEnumeratedProcessesVisited"),
                Value(Node::Bool(true)),
            ),
            (key("absenceOfReferencesProven"), Value(Node::Bool(false))),
            (key("treeWalkPerformed"), Value(Node::Bool(false))),
        ])))
    }
}
fn add(value: &mut usize, amount: usize, maximum: usize) -> Result<()> {
    *value = value
        .checked_add(amount)
        .filter(|&value| value <= maximum)
        .ok_or(ColdDataError::Reference)?;
    Ok(())
}
