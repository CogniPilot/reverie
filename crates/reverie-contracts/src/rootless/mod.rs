//! Named rootless worker data. Native profile/sub-ID observations are separate.
mod image;
mod integers;
mod profile;
use crate::legacy_json::{Node, Text, Value};
use crate::storage_identity::MetadataText;
use crate::worker_config::EffectiveWorkerConfig;
pub use image::{ImageMappings, RootlessImage, RootlessImageIdentity, parse_host_grants};
pub use integers::ImageInteger;
pub(crate) use integers::is_digit;
pub(crate) use integers::parse_python_digits;
pub(crate) use integers::parse_python_integer;
pub use profile::PreparedRootlessProfile;
use reverie_core::posix_path::PosixPath;
use reverie_core::worker_schema::{MountTarget, WorkerIds, require_account_mounts};
use std::collections::BTreeMap;
use std::fmt;
type Object = BTreeMap<Text, Value>;
type Result<T> = std::result::Result<T, RootlessError>;
pub const MAX_PROFILE_BYTES: usize = 65_536;
pub const MAX_SUBID_BYTES: usize = 1_048_576;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RootlessError {
    Option,
    Identity,
    Mount,
    Path,
    Digest,
    Json,
    Profile,
    ProfileBound,
    Syscalls,
    Perf,
    Image,
    SubIds,
}
impl RootlessError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Option => "ROOTLESS_OPTION",
            Self::Identity => "ROOTLESS_IDENTITY",
            Self::Mount => "ROOTLESS_MOUNTS",
            Self::Path => "ROOTLESS_PROFILE_PATH",
            Self::Digest => "ROOTLESS_PROFILE_DIGEST",
            Self::Json => "ROOTLESS_JSON",
            Self::Profile => "ROOTLESS_PROFILE",
            Self::ProfileBound => "ROOTLESS_PROFILE_BOUND",
            Self::Syscalls => "ROOTLESS_SYSCALLS",
            Self::Perf => "ROOTLESS_PERF",
            Self::Image => "ROOTLESS_IMAGE",
            Self::SubIds => "ROOTLESS_SUBIDS",
        }
    }
}
impl fmt::Display for RootlessError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for RootlessError {}
pub struct RootlessConfig {
    config: EffectiveWorkerConfig,
    option: Option<EnabledOption>,
}
struct EnabledOption {
    ids: WorkerIds,
    path: MetadataText,
    digest: MetadataText,
}
impl RootlessConfig {
    pub fn capture(config: EffectiveWorkerConfig) -> Result<Self> {
        let fields = object(config.as_value())?;
        let option = match field(fields, "rootlessDocker") {
            None | Some(Value(Node::Null)) => None,
            Some(value) => capture_option(&config, object(value)?)?,
        };
        Ok(Self { config, option })
    }
    /// Whether pure captured data requests enabled rootless mode. This is not
    /// worker_docker.enabled's native qualification; use the host observation.
    pub fn enabled(&self) -> bool {
        self.option.is_some()
    }
    pub fn configuration(&self) -> &EffectiveWorkerConfig {
        &self.config
    }
    pub fn ids(&self) -> Option<WorkerIds> {
        self.option.as_ref().map(|v| v.ids)
    }
    pub fn profile_path(&self) -> Option<&MetadataText> {
        self.option.as_ref().map(|v| &v.path)
    }
    pub fn needs_perf_recognition(&self) -> bool {
        field(
            object(self.config.as_value()).expect("worker object"),
            "_taskPerfPolicy",
        )
        .is_some()
            && self.enabled()
    }
    pub fn check_profile(
        &self,
        raw: &[u8],
        artifact: Option<&crate::task_perf_v1::TaskPerfArtifactData>,
    ) -> Result<()> {
        let Some(option) = &self.option else {
            return Ok(());
        };
        let prepared = profile::prepare(option, raw)?;
        profile::check(&self.config, option, &prepared, artifact)
    }
    /// Preserve original hash/JSON/default-deny checks before any fixed-artifact
    /// observation. The result is data and carries no native read qualification.
    pub fn prepare_profile(&self, raw: &[u8]) -> Result<Option<PreparedRootlessProfile>> {
        let prepared = self
            .option
            .as_ref()
            .map(|option| profile::prepare(option, raw))
            .transpose()?;
        if self.needs_perf_recognition() {
            crate::task_perf_v1::validate_selection_marker(&self.config)
                .map_err(|_| RootlessError::Perf)?;
        }
        Ok(prepared)
    }
    pub fn check_prepared_profile(
        &self,
        prepared: &PreparedRootlessProfile,
        artifact: Option<&crate::task_perf_v1::TaskPerfArtifactData>,
    ) -> Result<()> {
        let Some(option) = &self.option else {
            return Ok(());
        };
        profile::check(&self.config, option, prepared, artifact)
    }
    /// Call only after a fresh native enabled qualification in the consuming
    /// operation. Returned argument data neither invokes nor authorizes an engine.
    pub fn security_args(&self) -> Vec<MetadataText> {
        let values = if let Some(option) = &self.option {
            let mut path = "seccomp=".bytes().map(u32::from).collect::<Vec<_>>();
            path.extend(option.path.codepoints());
            let mut result = args(&[
                "--cap-drop",
                "ALL",
                "--cap-add",
                "SETUID",
                "--cap-add",
                "SETGID",
                "--security-opt",
            ]);
            result.push(MetadataText::from_text(Text(path)));
            result.extend(args(&[
                "--security-opt",
                "systempaths=unconfined",
                "--device",
                "/dev/net/tun:/dev/net/tun:rw",
            ]));
            return result;
        } else {
            ["--cap-drop", "ALL", "--security-opt", "no-new-privileges"].as_slice()
        };
        args(values)
    }
    pub fn runtime_args(&self) -> Vec<MetadataText> {
        let Some(option) = &self.option else {
            return Vec::new();
        };
        let mount = format!(
            "/run/reverie-docker:rw,nosuid,nodev,noexec,size=33554432,mode=0700,uid={},gid={}",
            option.ids.uid(),
            option.ids.gid()
        );
        args(&[
            "--tmpfs",
            &mount,
            "--env",
            "XDG_RUNTIME_DIR=/run/reverie-docker",
            "--env",
            "DOCKER_HOST=unix:///run/reverie-docker/docker.sock",
        ])
    }
    pub fn check_accounts(&self, accounts: &[MetadataText]) -> Result<()> {
        if !self.enabled() {
            return Ok(());
        }
        let fields = object(self.config.as_value())?;
        let targets = mount_targets(fields)?;
        let accounts = accounts
            .iter()
            .map(|value| {
                MountTarget::try_new(value.codepoints().to_vec()).map_err(|_| RootlessError::Mount)
            })
            .collect::<Result<Vec<_>>>()?;
        require_account_mounts(&targets.iter().collect::<Vec<_>>(), &accounts)
            .map_err(|_| RootlessError::Mount)
    }
}
fn capture_option(config: &EffectiveWorkerConfig, value: &Object) -> Result<Option<EnabledOption>> {
    if value.len() != 3
        || !["enabled", "seccompProfile", "seccompSha256"]
            .iter()
            .all(|name| field(value, name).is_some())
    {
        return Err(RootlessError::Option);
    }
    let enabled = match field(value, "enabled") {
        Some(Value(Node::Bool(value))) => *value,
        _ => return Err(RootlessError::Option),
    };
    if !enabled {
        return Ok(None);
    }
    let root = object(config.as_value())?;
    let ids = WorkerIds::try_new(
        strict_u32(field(root, "uid"))?,
        strict_u32(field(root, "gid"))?,
    )
    .map_err(|_| RootlessError::Identity)?;
    crate::worker_schema::validate_rootless_mounts(config).map_err(|_| RootlessError::Mount)?;
    let path = text(field(value, "seccompProfile"))?;
    let normalized = PosixPath::try_new(&path.0).map_err(|_| RootlessError::Path)?;
    let points = normalized.codepoints();
    if !normalized.is_absolute()
        || !points.starts_with(&"/nix/store/".bytes().map(u32::from).collect::<Vec<_>>())
    {
        return Err(RootlessError::Path);
    }
    let digest = match field(value, "seccompSha256") {
        Some(Value(Node::String(value))) => value.clone(),
        _ => Text(Vec::new()),
    };
    Ok(Some(EnabledOption {
        ids,
        path: MetadataText::from_text(path.clone()),
        digest: MetadataText::from_text(digest),
    }))
}
fn key(value: &str) -> Text {
    Text(value.bytes().map(u32::from).collect())
}
fn field<'a>(value: &'a Object, name: &str) -> Option<&'a Value> {
    value.get(&key(name))
}
fn object(value: &Value) -> Result<&Object> {
    if let Node::Object(value) = &value.0 {
        Ok(value)
    } else {
        Err(RootlessError::Option)
    }
}
fn text(value: Option<&Value>) -> Result<&Text> {
    if let Some(Value(Node::String(value))) = value {
        Ok(value)
    } else {
        Err(RootlessError::Path)
    }
}
fn strict_u32(value: Option<&Value>) -> Result<u32> {
    match value {
        Some(Value(Node::Number(crate::legacy_json::Number::Integer(value)))) => {
            value.parse().map_err(|_| RootlessError::Identity)
        }
        _ => Err(RootlessError::Identity),
    }
}
fn args(values: &[&str]) -> Vec<MetadataText> {
    values
        .iter()
        .map(|value| MetadataText::from_scalar_text(value))
        .collect()
}
fn mount_targets(root: &Object) -> Result<Vec<MountTarget>> {
    let values: &[Value] = match field(root, "mounts") {
        None => &[],
        Some(Value(Node::Array(values))) => values,
        _ => return Err(RootlessError::Mount),
    };
    values
        .iter()
        .map(|value| {
            MountTarget::try_new(text(field(object(value)?, "destination"))?.0.clone())
                .map_err(|_| RootlessError::Mount)
        })
        .collect()
}
