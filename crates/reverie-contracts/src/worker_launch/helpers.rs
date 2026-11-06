use super::*;
use crate::storage_identity::Metadata;
use reverie_core::ids::ProfileEmployeeId;
use sha2::{Digest, Sha256};

/// Paths/UID from the same captured worker domain. No filesystem qualification.
pub struct LaunchSettings {
    company_file: MetadataText,
    company_root: MetadataText,
    uid: u32,
}
impl LaunchSettings {
    pub fn capture(config: &EffectiveWorkerConfig) -> Result<Self> {
        let fields = object(config.as_value())?;
        Ok(Self {
            company_file: MetadataText::from_text(text(field(fields, "companyFile"))?.clone()),
            company_root: MetadataText::from_text(text(field(fields, "companyRoot"))?.clone()),
            uid: u32::try_from(integer(field(fields, "uid"))?)
                .map_err(|_| LaunchDataError::Configuration)?,
        })
    }
    pub fn company_file(&self) -> &MetadataText {
        &self.company_file
    }
    pub fn company_root(&self) -> &MetadataText {
        &self.company_root
    }
    pub fn uid(&self) -> u32 {
        self.uid
    }
}

/// Match exactly one ID+owner row, without imposing current-session/generation
/// or unrelated registry/plan rules that the hostname source never checked.
pub fn employee_hostname(
    company: &Metadata,
    employee: &ProfileEmployeeId,
    owner: &Option<MetadataText>,
) -> Result<String> {
    let fields = object(company.as_value()).map_err(|_| LaunchDataError::Employee)?;
    let Some(Value(Node::Array(rows))) = field(fields, "employees") else {
        return Err(LaunchDataError::Employee);
    };
    let mut selected = None;
    for row in rows {
        let row = object(row).map_err(|_| LaunchDataError::Employee)?;
        let matches_id = matches!(field(row, "id"), Some(Value(Node::String(id))) if id.equals_ascii(employee.as_str()));
        let matches_owner = match (field(row, "owner"), owner) {
            (None | Some(Value(Node::Null)), None) => true,
            (Some(Value(Node::String(actual))), Some(expected)) => {
                actual.0 == expected.codepoints()
            }
            _ => false,
        };
        if matches_id && matches_owner && selected.replace(row).is_some() {
            return Err(LaunchDataError::Employee);
        }
    }
    let row = selected.ok_or(LaunchDataError::Employee)?;
    let empty = Text(Vec::new());
    let name = if field(row, "name").is_none() {
        &empty
    } else {
        text(field(row, "name")).map_err(|_| LaunchDataError::Employee)?
    };
    Ok(reverie_core::worker_launch::employee_hostname(
        &name.0, employee,
    ))
}

/// cwd_bytes must be the POSIX fsencode of the RAW request cwd. The host
/// adapter owns that conversion; no pathname normalization belongs here.
pub fn temporary_environment(cwd_bytes: Option<&[u8]>) -> Vec<(String, String)> {
    let mut root = String::from("/tmp/reverie");
    if let Some(bytes) = cwd_bytes {
        let hash = crate::digest::hex(&Sha256::digest(bytes).into());
        root.push_str("/projects/");
        root.push_str(&hash[..24]);
    }
    [
        ("TMPDIR", "/tmp".to_owned()),
        ("TMP", "/tmp".to_owned()),
        ("TEMP", "/tmp".to_owned()),
        ("XDG_CACHE_HOME", format!("{root}/cache")),
        ("PIP_CACHE_DIR", format!("{root}/cache/pip")),
        ("UV_CACHE_DIR", format!("{root}/cache/uv")),
        ("npm_config_cache", format!("{root}/cache/npm")),
        ("CCACHE_DIR", format!("{root}/cache/ccache")),
        ("GOCACHE", format!("{root}/cache/go-build")),
        ("GOMODCACHE", format!("{root}/cache/go-mod")),
        ("XDG_DOWNLOAD_DIR", format!("{root}/downloads")),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value))
    .collect()
}

/// Fixed container tmux adapter DATA, not a host-command or admission endpoint.
/// The broker derives `name` from its selected session/container observation.
pub fn tmux_exec_args(
    name: &reverie_core::worker_launch::ContainerReference<'_>,
    command: &[MetadataText],
    attach: bool,
) -> Vec<MetadataText> {
    let mut args = vec![MetadataText::from_scalar_text("exec")];
    if attach {
        args.push(MetadataText::from_scalar_text("-it"));
    }
    args.extend(
        [
            "--env",
            "LANG=C.UTF-8",
            "--env",
            "LC_ALL=C.UTF-8",
            "--env",
            "TERM=xterm-256color",
            "--env",
            "COLORTERM=truecolor",
        ]
        .map(MetadataText::from_scalar_text),
    );
    args.push(MetadataText::from_scalar_text(name.as_str()));
    args.extend(["/bin/tmux", "-u", "-L", "reverie-laptop"].map(MetadataText::from_scalar_text));
    args.extend_from_slice(command);
    args
}
