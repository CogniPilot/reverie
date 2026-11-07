use super::*;
use crate::storage_identity::Metadata;
use reverie_core::ids::ProfileEmployeeId;

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
    match cwd_bytes {
        None => reverie_core::worker_child::TemporaryEnvironmentRoot::global(),
        Some(bytes) => crate::worker_child::project_temporary_root(bytes),
    }
    .entries()
}

/// Fixed container tmux adapter DATA, not a host-command or admission endpoint.
/// The broker derives `name` from its selected session/container observation.
pub fn tmux_exec_args(
    name: &reverie_core::worker_launch::ContainerReference<'_>,
    command: &[MetadataText],
    attach: bool,
) -> Vec<MetadataText> {
    tmux_exec_environment(name, command, attach, &[])
}
pub(super) fn tmux_exec_environment(
    name: &reverie_core::worker_launch::ContainerReference<'_>,
    command: &[MetadataText],
    attach: bool,
    environment: &[MetadataText],
) -> Vec<MetadataText> {
    tmux_exec_observed_environment(
        &MetadataText::from_scalar_text(name.as_str()),
        command,
        attach,
        environment,
    )
}
pub(crate) fn dead_pane_recheck(target: &MetadataText) -> Vec<MetadataText> {
    tmux_exec_observed_environment(
        target,
        &["display-message", "-p", "-t", "office", "#{pane_dead}"]
            .map(MetadataText::from_scalar_text),
        false,
        &[],
    )
}
fn tmux_exec_observed_environment(
    target: &MetadataText,
    command: &[MetadataText],
    attach: bool,
    environment: &[MetadataText],
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
    for entry in environment {
        args.push(MetadataText::from_scalar_text("--env"));
        args.push(entry.clone());
    }
    args.push(target.clone());
    args.extend(["/bin/tmux", "-u", "-L", "reverie-laptop"].map(MetadataText::from_scalar_text));
    args.extend_from_slice(command);
    args
}
