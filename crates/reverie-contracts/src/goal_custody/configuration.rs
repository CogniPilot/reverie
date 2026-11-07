use super::*;
use crate::legacy_json::{Number, ordered::OrderNode};
use crate::storage_identity::MetadataText;
use reverie_core::{
    ids::{ContainerId, ProfileSessionId},
    posix_path::PosixPath,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GoalPrivatePath {
    Config,
    Key,
    Canonical,
    Nonce,
    Authority,
}
impl GoalPrivatePath {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Config => "config",
            Self::Key => "key",
            Self::Canonical => "canonical",
            Self::Nonce => "nonce",
            Self::Authority => "authority",
        }
    }
    fn parse(name: &Text) -> Result<Self> {
        [
            Self::Config,
            Self::Key,
            Self::Canonical,
            Self::Nonce,
            Self::Authority,
        ]
        .into_iter()
        .find(|kind| name.equals_ascii(kind.as_str()))
        .ok_or(GoalDataError::Configuration)
    }
}
pub struct GoalPathPair {
    host: PosixPath,
    server: PosixPath,
}
impl GoalPathPair {
    pub fn host(&self) -> &PosixPath {
        &self.host
    }
    pub fn server(&self) -> &PosixPath {
        &self.server
    }
    fn decode(value: &Value) -> Result<Self> {
        let fields = object(value)?;
        exact(fields, &["host", "server"])?;
        Ok(Self {
            host: absolute(field(fields, "host")?)?,
            server: absolute(field(fields, "server")?)?,
        })
    }
}
pub struct GoalPrivateConfig {
    value: Value,
    owner_only: bool,
    server: ContainerId,
    paths: Vec<(GoalPrivatePath, GoalPathPair)>,
    broker_socket: PosixPath,
}
impl GoalPrivateConfig {
    /// Equivalent to GoalBrokerBootstrap.config's DATA checks. The caller
    /// separately captures the raw-byte digest and first private-file identity.
    pub fn decode(raw: &[u8], selected: &MetadataText, company: &MetadataText) -> Result<Self> {
        // Both named purposes use ordinary json.loads(bytes), including last
        // duplicate wins and encoding detection. Reuse its one shared codec.
        let decoded =
            legacy_json::decode_worker_request_bytes(raw).map_err(|_| GoalDataError::Json)?;
        let fields = object(&decoded.value)?;
        exact(
            fields,
            &[
                "version",
                "mode",
                "issuer",
                "epoch",
                "serverContainerId",
                "paths",
                "nonce",
                "server",
            ],
        )?;
        if integer(field(fields, "version")?)? != 1 {
            return Err(GoalDataError::Configuration);
        }
        let mode = text(field(fields, "mode")?)?;
        let owner_only = mode.equals_ascii("owner-only");
        if !owner_only && !mode.equals_ascii("owner-and-employee") {
            return Err(GoalDataError::Configuration);
        }
        for name in ["issuer", "epoch"] {
            identifier(field(fields, name)?)?;
        }
        let server = ContainerId::parse(&scalar(field(fields, "serverContainerId")?)?)
            .map_err(|_| GoalDataError::Configuration)?;
        let paths = paths(&decoded)?;
        if selected_path(&paths, GoalPrivatePath::Config)
            .host()
            .codepoints()
            != selected.codepoints()
            || selected_path(&paths, GoalPrivatePath::Canonical)
                .host()
                .codepoints()
                != company.codepoints()
            || selected_path(&paths, GoalPrivatePath::Key)
                .host()
                .is_relative_to(&PosixPath::from_scalar_text("/nix/store"))
        {
            return Err(GoalDataError::Scope);
        }
        validate_nonce(field(fields, "nonce")?)?;
        let transport = object(field(fields, "server")?)?;
        exact(transport, &["brokerSocket", "custodyClient"])?;
        let broker_socket = absolute(field(transport, "brokerSocket")?)?;
        absolute(field(transport, "custodyClient")?)?;
        Ok(Self {
            value: decoded.value,
            owner_only,
            server,
            paths,
            broker_socket,
        })
    }
    pub fn require_owner_only(&self) -> Result<()> {
        if self.owner_only {
            Ok(())
        } else {
            Err(GoalDataError::Mode)
        }
    }
    pub fn server_container(&self) -> &ContainerId {
        &self.server
    }
    pub fn broker_socket(&self) -> &PosixPath {
        &self.broker_socket
    }
    /// Preserve Python's original dictionary insertion order for the actual
    /// native path observations. Neither this iterator nor a path is a grant.
    pub fn paths(&self) -> impl ExactSizeIterator<Item = (GoalPrivatePath, &GoalPathPair)> {
        self.paths.iter().map(|(kind, pair)| (*kind, pair))
    }
    pub fn path(&self, kind: GoalPrivatePath) -> &GoalPathPair {
        selected_path(&self.paths, kind)
    }
    pub fn equivalent(&self, other: &Self) -> bool {
        self.value.python_eq(&other.value)
    }
}
fn selected_path(
    paths: &[(GoalPrivatePath, GoalPathPair)],
    kind: GoalPrivatePath,
) -> &GoalPathPair {
    &paths
        .iter()
        .find(|(name, _)| *name == kind)
        .expect("exact five-path constructor")
        .1
}
fn paths(
    decoded: &legacy_json::ordered::OrderedValue,
) -> Result<Vec<(GoalPrivatePath, GoalPathPair)>> {
    let fields = object(field(object(&decoded.value)?, "paths")?)?;
    exact(
        fields,
        &["config", "key", "canonical", "nonce", "authority"],
    )?;
    let index = decoded
        .root_child_index(&key("paths"))
        .ok_or(GoalDataError::Configuration)?;
    let Some(OrderNode::Object(order)) = decoded.graph.nodes.get(index) else {
        return Err(GoalDataError::Configuration);
    };
    order
        .iter()
        .map(|(name, _)| {
            Ok((
                GoalPrivatePath::parse(name)?,
                GoalPathPair::decode(fields.get(name).ok_or(GoalDataError::Configuration)?)?,
            ))
        })
        .collect()
}
fn validate_nonce(value: &Value) -> Result<()> {
    let fields = object(value)?;
    exact(fields, &["storeId", "capacity", "flockExecutable"])?;
    ProfileSessionId::parse(&scalar(field(fields, "storeId")?)?)
        .map_err(|_| GoalDataError::Configuration)?;
    if !(1..=4096).contains(&integer(field(fields, "capacity")?)?) {
        return Err(GoalDataError::Configuration);
    }
    absolute(field(fields, "flockExecutable")?)?;
    Ok(())
}
fn integer(value: &Value) -> Result<u32> {
    match &value.0 {
        Node::Number(Number::Integer(value)) => {
            value.parse().map_err(|_| GoalDataError::Configuration)
        }
        _ => Err(GoalDataError::Configuration),
    }
}
fn identifier(value: &Value) -> Result<()> {
    let value = scalar(value)?;
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
    {
        return Err(GoalDataError::Configuration);
    }
    Ok(())
}
fn scalar(value: &Value) -> Result<String> {
    text(value)?
        .0
        .iter()
        .map(|&point| char::from_u32(point))
        .collect::<Option<_>>()
        .ok_or(GoalDataError::Configuration)
}
fn absolute(value: &Value) -> Result<PosixPath> {
    let points = &text(value)?.0;
    let path = PosixPath::try_new(points).map_err(|_| GoalDataError::Path)?;
    if points.first() != Some(&47)
        || points == &[47]
        || points.iter().any(|p| [0, 10, 13].contains(p))
        || path.codepoints() != *points
        || path.has_parent_component()
    {
        return Err(GoalDataError::Path);
    }
    Ok(path)
}
