//! Pure worker base and mount rules. These values grant no host access.
use crate::resources::ResourcePolicy;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerRuleError {
    Identity,
    Image,
    IntegerLimit,
    MountTarget,
    ReservedMount,
    Overlap,
    ImmutableMount,
    AccountMount,
}

/// Strict integer UID/GID data, independent of a native principal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkerIds {
    uid: u32,
    gid: u32,
}
impl WorkerIds {
    pub fn try_new(uid: u32, gid: u32) -> Result<Self, WorkerRuleError> {
        if !(1..=i32::MAX as u32).contains(&uid) || !(1..=i32::MAX as u32).contains(&gid) {
            return Err(WorkerRuleError::IntegerLimit);
        }
        Ok(Self { uid, gid })
    }
    pub fn uid(self) -> u32 {
        self.uid
    }
    pub fn gid(self) -> u32 {
        self.gid
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerBase {
    deployment: String,
    container: String,
    image: String,
    ids: WorkerIds,
    maximum: u8,
    resources: ResourcePolicy,
}
impl WorkerBase {
    pub fn try_new(
        deployment: String,
        container: String,
        image: String,
        ids: WorkerIds,
        maximum: u8,
        resources: ResourcePolicy,
    ) -> Result<Self, WorkerRuleError> {
        if !name(&deployment, 40, false) || !name(&container, 63, true) {
            return Err(WorkerRuleError::Identity);
        }
        if image.len() != 71
            || !image.starts_with("sha256:")
            || !image.as_bytes()[7..]
                .iter()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        {
            return Err(WorkerRuleError::Image);
        }
        if !(1..=32).contains(&maximum) {
            return Err(WorkerRuleError::IntegerLimit);
        }
        Ok(Self {
            deployment,
            container,
            image,
            ids,
            maximum,
            resources,
        })
    }
    pub fn deployment(&self) -> &str {
        &self.deployment
    }
    pub fn container(&self) -> &str {
        &self.container
    }
    pub fn image(&self) -> &str {
        &self.image
    }
    pub fn ids(&self) -> WorkerIds {
        self.ids
    }
    pub fn max_workers(&self) -> u8 {
        self.maximum
    }
    /// Source broker connection admission includes four control/viewer seats.
    /// This is a configured bound, never permission to launch a worker.
    pub fn connection_limit(&self) -> usize {
        usize::from(self.maximum) + 4
    }
    pub fn resources(&self) -> &ResourcePolicy {
        &self.resources
    }
}

/// The immutable identity/capacity of one installed worker service. Image and
/// resources deliberately remain with the current validated configuration:
/// both can change through their supported source refresh/reload paths.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerServiceIdentity {
    deployment: String,
    container: String,
    ids: WorkerIds,
    maximum: u8,
    connections: usize,
}
impl WorkerServiceIdentity {
    pub fn capture(base: &WorkerBase) -> Self {
        Self {
            deployment: base.deployment().to_owned(),
            container: base.container().to_owned(),
            ids: base.ids(),
            maximum: base.max_workers(),
            connections: base.connection_limit(),
        }
    }
    pub fn deployment(&self) -> &str {
        &self.deployment
    }
    pub fn container(&self) -> &str {
        &self.container
    }
    pub fn ids(&self) -> WorkerIds {
        self.ids
    }
    pub fn max_workers(&self) -> u8 {
        self.maximum
    }
    pub fn connection_limit(&self) -> usize {
        self.connections
    }
}
pub(crate) fn name(value: &str, maximum: usize, container: bool) -> bool {
    let alphanumeric = |b: u8| {
        b.is_ascii_digit() || b.is_ascii_lowercase() || (container && b.is_ascii_uppercase())
    };
    !value.is_empty()
        && value.len() <= maximum
        && alphanumeric(value.as_bytes()[0])
        && value
            .bytes()
            .all(|b| alphanumeric(b) || b == b'-' || (container && (b == b'_' || b == b'.')))
}

/// Canonical POSIX target retaining Python codepoints, including surrogates.
/// Character restrictions belong to each caller, not pathlib's target rule.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct MountTarget(Vec<u32>);
impl MountTarget {
    pub fn try_new(value: Vec<u32>) -> Result<Self, WorkerRuleError> {
        if value.iter().any(|&c| c > 0x10ffff)
            || value.first() != Some(&47)
            || (value.len() > 1 && (value[1] == 47 || value.last() == Some(&47)))
            || (value.len() > 1
                && value
                    .split(|&c| c == 47)
                    .skip(1)
                    .any(|part| part.is_empty() || part == [46] || part == [46, 46]))
        {
            return Err(WorkerRuleError::MountTarget);
        }
        Ok(Self(value))
    }
    pub fn codepoints(&self) -> &[u32] {
        &self.0
    }
    fn equals(&self, value: &str) -> bool {
        self.0.iter().copied().eq(value.bytes().map(u32::from))
    }
    fn under(&self, value: &str) -> bool {
        let root: Vec<u32> = value.bytes().map(u32::from).collect();
        self.0.starts_with(&root)
            && (self.0.len() == root.len() || self.0.get(root.len()) == Some(&47))
    }
    fn overlaps(&self, other: &Self) -> bool {
        fn within(value: &[u32], root: &[u32]) -> bool {
            value.starts_with(root)
                && (root == [47] || value.len() == root.len() || value.get(root.len()) == Some(&47))
        }
        within(&self.0, &other.0) || within(&other.0, &self.0)
    }
    /// General worker destination bans; intentionally not a rootless allowlist.
    pub fn worker_destination(&self) -> Result<(), WorkerRuleError> {
        if self.under("/reverie_workspace/attachments")
            || [
                "/",
                "/home/agent",
                "/nix",
                "/proc",
                "/sys",
                "/dev",
                "/run",
                "/var/run",
            ]
            .iter()
            .any(|v| self.equals(v))
            || ((self.under("/run") || self.under("/var/run"))
                && !self.equals("/run/reverie-model"))
        {
            return Err(WorkerRuleError::ReservedMount);
        }
        Ok(())
    }
}

pub struct RootlessMount<'a> {
    pub target: &'a MountTarget,
    pub read_only_is_true: bool,
}
pub fn require_disjoint(targets: &[&MountTarget]) -> Result<(), WorkerRuleError> {
    for (index, target) in targets.iter().enumerate() {
        if targets[..index].iter().any(|other| target.overlaps(other)) {
            return Err(WorkerRuleError::Overlap);
        }
    }
    Ok(())
}
/// Complete pure body of worker_docker.require_immutable_mounts.
pub fn require_immutable_mounts(mounts: &[RootlessMount<'_>]) -> Result<(), WorkerRuleError> {
    let protected = [
        "/opt/reverie-idmap",
        "/opt/idmap",
        "/bin/newuidmap",
        "/bin/newgidmap",
        "/etc/passwd",
        "/etc/group",
        "/etc/subuid",
        "/etc/subgid",
        "/etc/nsswitch.conf",
        "/etc/ld.so.preload",
        "/etc/ld.so.cache",
    ];
    for mount in mounts {
        let target = mount.target;
        if protected
            .iter()
            .any(|p| target.overlaps(&MountTarget(p.bytes().map(u32::from).collect())))
        {
            return Err(WorkerRuleError::ImmutableMount);
        }
        let readonly = [
            "/host-published",
            "/instances/default/tools",
            "/instances/default/console/statusline-exporter.sh",
            "/run/reverie-model",
        ]
        .iter()
        .any(|p| target.equals(p));
        let drive = ["/workspace", "/reverie_workspace", "/projects"]
            .iter()
            .any(|p| target.equals(p));
        let child = target
            .0
            .strip_prefix(&"/projects/".bytes().map(u32::from).collect::<Vec<_>>()[..]);
        let project = child.is_some_and(|part| {
            !part.is_empty()
                && part.len() <= 100
                && part[0] <= 127
                && (part[0] as u8).is_ascii_alphanumeric()
                && part.iter().all(|&c| {
                    c <= 127 && ((c as u8).is_ascii_alphanumeric() || [45, 46, 95].contains(&c))
                })
        });
        if (readonly && !mount.read_only_is_true) || !(readonly || drive || project) {
            return Err(WorkerRuleError::ImmutableMount);
        }
    }
    require_disjoint(&mounts.iter().map(|mount| mount.target).collect::<Vec<_>>())
}
/// Pure account-target body. Caller must separately establish enabled rootless
/// configuration (including its native seccomp observation).
pub fn require_account_mounts(
    base: &[&MountTarget],
    accounts: &[MountTarget],
) -> Result<(), WorkerRuleError> {
    for target in accounts {
        if ![
            "/instances/default/accounts",
            "/instances/default/console/accounts",
        ]
        .iter()
        .any(|root| target.under(root) && !target.equals(root))
        {
            return Err(WorkerRuleError::AccountMount);
        }
    }
    let mut targets = base.to_vec();
    targets.extend(accounts);
    require_disjoint(&targets)
}
