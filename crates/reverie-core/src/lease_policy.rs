//! Pure legacy lease-grant path/ELF policy. These checked data are not native
//! observations, mounted-artifact proof, process eligibility or effect authority.
use crate::ids::ProfileEmployeeId;
use std::fmt;

pub const PEER_TARGET: &str = "/opt/reverie-acceptance-peer";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LeasePolicyError {
    AbsolutePath,
    RelativePath,
    Socket,
    ControlDirectory,
    MountNamespace,
    ArtifactAlias,
    ElfFormat,
    ElfMachine,
    ElfHeaders,
    DynamicElf,
}
impl LeasePolicyError {
    pub fn code(self) -> &'static str {
        match self {
            Self::AbsolutePath => "LEASE_ABSOLUTE_PATH",
            Self::RelativePath => "LEASE_RELATIVE_PATH",
            Self::Socket => "LEASE_SOCKET",
            Self::ControlDirectory => "LEASE_CONTROL_DIRECTORY",
            Self::MountNamespace => "LEASE_MOUNT_NAMESPACE",
            Self::ArtifactAlias => "LEASE_ARTIFACT_ALIAS",
            Self::ElfFormat => "PEER_ELF_FORMAT",
            Self::ElfMachine => "PEER_ELF_MACHINE",
            Self::ElfHeaders => "PEER_ELF_HEADERS",
            Self::DynamicElf => "PEER_DYNAMIC_ELF",
        }
    }
}
impl fmt::Display for LeasePolicyError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for LeasePolicyError {}
type Result<T> = std::result::Result<T, LeasePolicyError>;

/// POSIX lexical data, preserving Python strings including lone surrogates.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeaseAbsolutePath(Vec<u32>);
impl LeaseAbsolutePath {
    pub fn try_new(value: Vec<u32>) -> Result<Self> {
        if value.first() != Some(&47)
            || !characters(&value)
            || (value.len() > 1 && value.last() == Some(&47))
            || value.get(1) == Some(&47)
            || !segments(&value[1..])
        {
            return Err(LeasePolicyError::AbsolutePath);
        }
        Ok(Self(value))
    }
    pub fn from_scalar_text(value: &str) -> Result<Self> {
        Self::try_new(value.chars().map(u32::from).collect())
    }
    pub fn codepoints(&self) -> &[u32] {
        &self.0
    }
    pub fn scalar_text(&self) -> Option<String> {
        self.0.iter().map(|&value| char::from_u32(value)).collect()
    }
    pub fn parent(&self) -> Self {
        let end = self
            .0
            .iter()
            .rposition(|&value| value == 47)
            .expect("absolute slash")
            .max(1);
        Self(self.0[..end].to_vec())
    }
    pub fn is_relative_to(&self, other: &Self) -> bool {
        other.0 == [47]
            || self.0 == other.0
            || (self.0.starts_with(&other.0) && self.0.get(other.0.len()) == Some(&47))
    }
    pub fn overlaps(&self, other: &Self) -> bool {
        self.is_relative_to(other) || other.is_relative_to(self)
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeaseRelativePath(Vec<u32>);
impl LeaseRelativePath {
    pub fn try_new(value: Vec<u32>) -> Result<Self> {
        if value.is_empty()
            || value.first() == Some(&47)
            || !characters(&value)
            || (value != [46] && !segments(&value))
        {
            return Err(LeasePolicyError::RelativePath);
        }
        Ok(Self(value))
    }
    pub fn from_scalar_text(value: &str) -> Result<Self> {
        Self::try_new(value.chars().map(u32::from).collect())
    }
    pub fn codepoints(&self) -> &[u32] {
        &self.0
    }
}
fn characters(value: &[u32]) -> bool {
    value.iter().all(|&value| (32..=0x10ffff).contains(&value))
}
fn segments(value: &[u32]) -> bool {
    value.is_empty()
        || value
            .split(|&value| value == 47)
            .all(|part| !part.is_empty() && part != [46] && part != [46, 46])
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeaseControlContext {
    state: LeaseAbsolutePath,
    broker_parent: Vec<u32>,
}
impl LeaseControlContext {
    /// The ordinary broker path uses Python Path(...).parent semantics; unlike
    /// the lease socket, legacy validate_option does not canonicalize that field.
    pub fn try_new(
        state: LeaseAbsolutePath,
        broker_socket: &[u32],
        positive_uid: bool,
    ) -> Result<Self> {
        if !positive_uid || broker_socket.iter().any(|&value| value > 0x10ffff) {
            return Err(LeasePolicyError::Socket);
        }
        Ok(Self {
            state,
            broker_parent: python_parent(broker_socket),
        })
    }
}
fn python_parent(value: &[u32]) -> Vec<u32> {
    let leading = value.iter().take_while(|&&value| value == 47).count();
    let anchor = match leading {
        0 => 0,
        2 => 2,
        _ => 1,
    };
    let mut parts: Vec<_> = value
        .split(|&value| value == 47)
        .filter(|part| !part.is_empty() && *part != [46])
        .collect();
    parts.pop();
    let mut result = vec![47; anchor];
    for part in parts {
        if !result.is_empty() && result.last() != Some(&47) {
            result.push(47);
        }
        result.extend_from_slice(part);
    }
    if result.is_empty() {
        result.push(46);
    }
    result
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeaseMountView {
    source: LeaseAbsolutePath,
    destination: LeaseAbsolutePath,
}
impl LeaseMountView {
    pub fn new(source: LeaseAbsolutePath, destination: LeaseAbsolutePath) -> Self {
        Self {
            source,
            destination,
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeaseAcceptance {
    socket: LeaseAbsolutePath,
    employee: ProfileEmployeeId,
    subdirectory: LeaseRelativePath,
    peer_binary: LeaseAbsolutePath,
}
impl LeaseAcceptance {
    pub fn try_new(
        socket: LeaseAbsolutePath,
        employee: ProfileEmployeeId,
        subdirectory: LeaseRelativePath,
        peer_binary: LeaseAbsolutePath,
        context: &LeaseControlContext,
        mounts: &[LeaseMountView],
    ) -> Result<Self> {
        let socket_text = socket.scalar_text().ok_or(LeasePolicyError::Socket)?;
        if socket_text.len() > 100 {
            return Err(LeasePolicyError::Socket);
        }
        let parent = socket.parent();
        let employees = append(&context.state, "employees");
        if parent.0 == context.broker_parent
            || parent == context.state
            || !parent.is_relative_to(&context.state)
            || parent.is_relative_to(&employees)
        {
            return Err(LeasePolicyError::ControlDirectory);
        }
        validate_mounts(mounts, &peer_binary)?;
        Ok(Self {
            socket,
            employee,
            subdirectory,
            peer_binary,
        })
    }
    pub fn socket(&self) -> &LeaseAbsolutePath {
        &self.socket
    }
    pub fn employee(&self) -> &ProfileEmployeeId {
        &self.employee
    }
    pub fn subdirectory(&self) -> &LeaseRelativePath {
        &self.subdirectory
    }
    pub fn peer_binary(&self) -> &LeaseAbsolutePath {
        &self.peer_binary
    }
}
fn append(base: &LeaseAbsolutePath, component: &str) -> LeaseAbsolutePath {
    let mut result = base.0.clone();
    if result.last() != Some(&47) {
        result.push(47);
    }
    result.extend(component.bytes().map(u32::from));
    LeaseAbsolutePath(result)
}
fn validate_mounts(mounts: &[LeaseMountView], source: &LeaseAbsolutePath) -> Result<()> {
    let target = LeaseAbsolutePath::from_scalar_text(PEER_TARGET).expect("fixed path");
    let opt = LeaseAbsolutePath::from_scalar_text("/opt").expect("fixed path");
    let bin = LeaseAbsolutePath::from_scalar_text("/bin").expect("fixed path");
    for mount in mounts {
        if target.is_relative_to(&mount.destination)
            || mount.destination.is_relative_to(&opt)
            || mount.destination.is_relative_to(&bin)
        {
            return Err(LeasePolicyError::MountNamespace);
        }
        if mount.source.overlaps(source) {
            return Err(LeasePolicyError::ArtifactAlias);
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PeerMachine {
    X86_64,
    Aarch64,
}
impl PeerMachine {
    fn elf_machine(self) -> u16 {
        match self {
            Self::X86_64 => 62,
            Self::Aarch64 => 183,
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StaticPeerElf {
    machine: PeerMachine,
    program_headers: u16,
}
impl StaticPeerElf {
    pub fn machine(self) -> PeerMachine {
        self.machine
    }
    pub fn program_headers(self) -> u16 {
        self.program_headers
    }
}
/// Preserve peer_artifact.static_elf's exact header checks. This does not prove
/// the kernel executed or mounted these bytes, or validate their behavior.
pub fn static_peer_elf(data: &[u8], machine: PeerMachine) -> Result<StaticPeerElf> {
    if data.len() < 64 || data[..7] != [0x7f, b'E', b'L', b'F', 2, 1, 1] {
        return Err(LeasePolicyError::ElfFormat);
    }
    if u16_at(data, 16) != 2 || u16_at(data, 18) != machine.elf_machine() {
        return Err(LeasePolicyError::ElfMachine);
    }
    let offset = u64::from_le_bytes(data[32..40].try_into().expect("ELF header"));
    let size = u16_at(data, 54);
    let count = u16_at(data, 56);
    let end = offset.checked_add(u64::from(size) * u64::from(count));
    if size < 56 || count == 0 || count > 128 || end.is_none_or(|end| end > data.len() as u64) {
        return Err(LeasePolicyError::ElfHeaders);
    }
    let offset = usize::try_from(offset).map_err(|_| LeasePolicyError::ElfHeaders)?;
    for index in 0..usize::from(count) {
        let start = offset + index * usize::from(size);
        let kind = u32::from_le_bytes(
            data[start..start + 4]
                .try_into()
                .expect("bounded program header"),
        );
        if matches!(kind, 2 | 3) {
            return Err(LeasePolicyError::DynamicElf);
        }
    }
    Ok(StaticPeerElf {
        machine,
        program_headers: count,
    })
}
fn u16_at(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(data[offset..offset + 2].try_into().expect("ELF header"))
}
