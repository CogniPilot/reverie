use super::*;
use crate::worker_config::{self, WorkerConfigDigest, WorkerPolicyDigest};
use reverie_core::{
    ids::{ProfileEmployeeId, ProfileSessionId},
    posix_path::PosixPath,
    worker_launch::WorkerName,
};

/// Fresh read-side qualification outputs supplied by the application in source
/// order. They are ordinary data, not reusable native evidence or start grants.
pub struct CreateObservations<'a> {
    pub security: &'a [MetadataText],
    pub runtime: &'a [MetadataText],
    pub gpu: &'a [String],
    pub employee: Option<(&'a ProfileEmployeeId, &'a str)>,
}
pub struct CreateArguments {
    name: WorkerName,
    digest: WorkerConfigDigest,
    policy: WorkerPolicyDigest,
    args: Vec<MetadataText>,
    tail_offset: usize,
}
/// Bind name and both hashes to the same effective captured configuration,
/// before any rootless/GPU/hostname observation. This is immutable DATA.
pub struct CreatePreparation<'a> {
    config: &'a EffectiveWorkerConfig,
    session: &'a ProfileSessionId,
    name: WorkerName,
    digest: WorkerConfigDigest,
    policy: WorkerPolicyDigest,
    init: WorkerInitData,
}
impl<'a> CreatePreparation<'a> {
    pub fn capture(
        config: &'a EffectiveWorkerConfig,
        session: &'a ProfileSessionId,
    ) -> Result<Self> {
        let fields = object(config.as_value())?;
        Ok(Self {
            config,
            session,
            name: WorkerName::for_session(&scalar(field(fields, "deployment"))?, session)?,
            digest: worker_config::config_digest(config),
            policy: worker_config::policy_digest(config),
            init: WorkerInitData::for_effective(config)?,
        })
    }
    pub fn arguments(
        self,
        home: &MetadataText,
        scratch: Option<&MetadataText>,
        observed: CreateObservations<'_>,
    ) -> Result<CreateArguments> {
        render(self, home, scratch, observed)
    }
}
impl CreateArguments {
    pub fn name(&self) -> &str {
        self.name.as_str()
    }
    pub fn worker_name(&self) -> &WorkerName {
        &self.name
    }
    pub fn config_digest(&self) -> &WorkerConfigDigest {
        &self.digest
    }
    pub fn policy_digest(&self) -> &WorkerPolicyDigest {
        &self.policy
    }
    pub fn args(&self) -> &[MetadataText] {
        &self.args
    }
    /// Exact image in this closed argv tail; never a new runtime selection.
    pub fn image(&self) -> &MetadataText {
        &self.args[self.tail_offset + 2]
    }
    /// Late mounts precede the captured closed layout's entrypoint/image tail.
    /// Inputs are mount DATA; the real Host owner derives them from its retained
    /// Nix result and fresh account observations before the telemetry boundary.
    pub fn with_late_mounts(
        &self,
        nix: Option<&MetadataText>,
        accounts: &[MetadataText],
    ) -> Vec<MetadataText> {
        let mut args = self.args.clone();
        let mut extra = Vec::new();
        if let Some(nix) = nix {
            extra.push(MetadataText::from_scalar_text("--mount"));
            extra.push(bind(nix, &MetadataText::from_scalar_text("/nix"), false));
        }
        extra.extend_from_slice(accounts);
        args.splice(self.tail_offset..self.tail_offset, extra);
        args
    }
}
/// Format valid upstream effective configuration plus storage-selected paths.
/// This does not validate the whole worker domain or confer effect authority.
pub fn create_arguments(
    config: &EffectiveWorkerConfig,
    session: &ProfileSessionId,
    home: &MetadataText,
    scratch: Option<&MetadataText>,
    observed: CreateObservations<'_>,
) -> Result<CreateArguments> {
    CreatePreparation::capture(config, session)?.arguments(home, scratch, observed)
}
fn render(
    prepared: CreatePreparation<'_>,
    home: &MetadataText,
    scratch: Option<&MetadataText>,
    observed: CreateObservations<'_>,
) -> Result<CreateArguments> {
    let CreatePreparation {
        config,
        session,
        name,
        digest,
        policy,
        init,
    } = prepared;
    let fields = object(config.as_value())?;
    let deployment = scalar(field(fields, "deployment"))?;
    let mut args = words(&[
        "create",
        "--name",
        name.as_str(),
        init.engine_init_argument(),
        "--restart",
        "no",
        "--read-only",
    ]);
    args.extend_from_slice(observed.security);
    let user = format!(
        "{}:{}",
        integer(field(fields, "uid"))?,
        integer(field(fields, "gid"))?
    );
    args.extend(words(&[
        "--label",
        &format!("reverie.worker={deployment}"),
        "--label",
        &format!("reverie.session={session}"),
        "--label",
        &format!("reverie.worker-config={}", digest.to_hex()),
        "--label",
        &format!("reverie.worker-policy={}", policy.to_hex()),
        "--user",
        &user,
        "--cpu-shares",
        "1024",
        "--pids-limit",
        &integer(field(fields, "pidsLimit"))?.to_string(),
        "--network",
        &format!("{}-lan", name.as_str()),
        "--tmpfs",
        "/run:rw,nosuid,nodev,size=16777216",
        "--mount",
    ]));
    args.push(bind(
        home,
        &MetadataText::from_scalar_text("/home/agent"),
        false,
    ));
    args.extend(words(&[
        "--env",
        "HOME=/home/agent",
        "--env",
        "REVERIE_WORKER=1",
        "--env",
        "REVERIE_INSTALL_CLIS=none",
    ]));
    args.extend_from_slice(observed.runtime);
    let scratch = scratch_path(fields, session, scratch)?;
    storage_mounts(&mut args, fields, session, &scratch)?;
    for (key, value) in temporary_environment(None) {
        args.extend(words(&["--env", &format!("{key}={value}")]));
    }
    resources(&mut args, fields)?;
    declared_mounts(&mut args, config)?;
    args.extend(
        observed
            .gpu
            .iter()
            .map(|arg| MetadataText::from_scalar_text(arg)),
    );
    if let Some((employee, hostname)) = observed.employee {
        args.extend(words(&[
            "--label",
            &format!("reverie.employee={employee}"),
            "--label",
            &format!("reverie.storage=employee:{employee}"),
            "--hostname",
            hostname,
        ]));
    }
    let tail_offset = args.len();
    args.extend(words(&[
        "--entrypoint",
        init.entrypoint(),
        &scalar(field(fields, "image"))?,
    ]));
    args.extend(words(init.command()));
    Ok(CreateArguments {
        name,
        digest,
        policy,
        args,
        tail_offset,
    })
}
fn scratch_path(
    fields: &Object,
    session: &ProfileSessionId,
    scratch: Option<&MetadataText>,
) -> Result<MetadataText> {
    match scratch {
        Some(value) => Ok(value.clone()),
        None => join(
            &MetadataText::from_text(text(field(fields, "scratchRoot"))?.clone()),
            session.as_str(),
        ),
    }
}
fn words(values: &[&str]) -> Vec<MetadataText> {
    values
        .iter()
        .map(|value| MetadataText::from_scalar_text(value))
        .collect()
}
fn join(value: &MetadataText, suffix: &str) -> Result<MetadataText> {
    let path =
        PosixPath::try_new(value.codepoints()).map_err(|_| LaunchDataError::Configuration)?;
    Ok(MetadataText::from_text(Text(
        path.join(&PosixPath::from_scalar_text(suffix)).codepoints(),
    )))
}
pub(super) fn bind(
    source: &MetadataText,
    destination: &MetadataText,
    readonly: bool,
) -> MetadataText {
    let mut points: Vec<u32> = "type=bind,src=".chars().map(u32::from).collect();
    points.extend(source.codepoints());
    points.extend(",dst=".chars().map(u32::from));
    points.extend(destination.codepoints());
    if readonly {
        points.extend(",readonly".chars().map(u32::from));
    }
    MetadataText::from_text(Text(points))
}
fn storage_mounts(
    args: &mut Vec<MetadataText>,
    fields: &Object,
    session: &ProfileSessionId,
    scratch: &MetadataText,
) -> Result<()> {
    let scratch = join(scratch, "")?;
    let socket = join(
        &MetadataText::from_text(text(field(fields, "apiSocketRoot"))?.clone()),
        session.as_str(),
    )?;
    for (source, target, readonly) in [
        (join(&scratch, "tmp")?, "/tmp", false),
        (scratch, "/scratch", false),
        (socket, "/run/reverie-office", true),
    ] {
        args.extend(words(&["--mount"]));
        args.push(bind(
            &source,
            &MetadataText::from_scalar_text(target),
            readonly,
        ));
    }
    Ok(())
}
fn resources(args: &mut Vec<MetadataText>, fields: &Object) -> Result<()> {
    if text(field(fields, "budgetMode"))?.equals_ascii("pool") {
        args.extend(words(&[
            "--cgroup-parent",
            &scalar(field(fields, "cgroupParent"))?,
        ]));
    }
    let memory = integer(field(fields, "memoryMiB"))?;
    if memory != 0 {
        let swap = field(fields, "laptopMemoryPolicy")
            .map(object)
            .transpose()?
            .and_then(|policy| field(policy, "swapMiB"))
            .map(|value| integer(Some(value)))
            .transpose()?
            .unwrap_or(0);
        args.extend(words(&[
            "--memory",
            &format!("{memory}m"),
            "--memory-swap",
            &format!(
                "{}m",
                memory
                    .checked_add(swap)
                    .ok_or(LaunchDataError::Configuration)?
            ),
        ]));
    }
    let cpus = field(fields, "cpus").ok_or(LaunchDataError::Configuration)?;
    if crate::legacy_json::truthy(Some(cpus)) {
        let rendered = String::from_utf8(worker_config::encode_data(cpus))
            .map_err(|_| LaunchDataError::Configuration)?;
        args.extend(words(&["--cpus", &rendered]));
    }
    Ok(())
}
fn declared_mounts(args: &mut Vec<MetadataText>, config: &EffectiveWorkerConfig) -> Result<()> {
    let mounts = mounts(config)?;
    let alias = workspace_alias(&mounts);
    for mount in &mounts {
        args.extend(words(&["--mount"]));
        args.push(bind(mount.source(), mount.destination(), mount.read_only()));
    }
    if let Some(alias) = alias {
        args.extend(words(&["--mount"]));
        args.push(bind(
            alias.source(),
            &MetadataText::from_scalar_text("/workspace"),
            alias.read_only(),
        ));
    }
    if mounts.iter().any(|mount| {
        PosixPath::try_new(mount.destination().codepoints())
            .is_ok_and(|path| path == PosixPath::from_scalar_text("/reverie_workspace"))
    }) {
        args.extend(words(&["--mount", "type=tmpfs,dst=/reverie_workspace/attachments,tmpfs-mode=0555,tmpfs-size=1048576,readonly"]));
        if alias.is_some() {
            args.extend(words(&[
                "--mount",
                "type=tmpfs,dst=/workspace/attachments,tmpfs-mode=0555,tmpfs-size=1048576,readonly",
            ]));
        }
    }
    Ok(())
}
