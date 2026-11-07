use super::*;
use reverie_core::ids::ProfileSessionId;

/// Fixed networkless, read-only helper argv DATA. Native invocation belongs to
/// the installed service and actual held-store lifecycle, not this value.
pub struct NixPreparationArguments {
    name: MetadataText,
    arguments: Vec<MetadataText>,
}
impl NixPreparationArguments {
    pub fn capture(
        config: &NixConfiguration,
        session: &ProfileSessionId,
        selected_path: &MetadataText,
    ) -> Result<Self> {
        let fields = config.fields();
        let deployment = string(field(fields, "deployment"))?;
        let name = join(&[
            &deployment,
            &MetadataText::from_scalar_text("-nix-prepare-"),
            &MetadataText::from_scalar_text(session.as_str()),
        ]);
        let mut arguments = texts(&["create", "--name"]);
        arguments.push(name.clone());
        arguments.extend(texts(&[
            "--init",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--network",
            "none",
            "--user",
        ]));
        arguments.push(MetadataText::from_scalar_text(&format!(
            "{}:{}",
            config.integer("uid")?,
            config.integer("gid")?
        )));
        arguments.push(MetadataText::from_scalar_text("--label"));
        arguments.push(prefix("reverie.nix-prepare=", &deployment));
        arguments.extend(texts(&[
            "--label",
            &format!("reverie.session={}", session.as_str()),
            "--memory",
            "512m",
            "--memory-swap",
            "512m",
            "--pids-limit",
            "128",
            "--cpus",
            "1",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=268435456,mode=1777",
            "--tmpfs",
            "/nix/store/.links:rw,nosuid,nodev,size=1048576,mode=1777",
            "--mount",
        ]));
        arguments.push(join(&[
            &MetadataText::from_scalar_text("type=bind,src="),
            selected_path,
            &MetadataText::from_scalar_text(",dst=/target/nix"),
        ]));
        arguments.extend(texts(&[
            "--env",
            "HOME=/tmp/nix-bootstrap-home",
            "--env",
            "TMPDIR=/tmp",
            "--entrypoint",
            "/bin/reverie-nix-store-prepare",
        ]));
        arguments.push(config.image()?);
        if equal(field(fields, "budgetMode"), "pool") {
            arguments.splice(
                1..1,
                [
                    MetadataText::from_scalar_text("--cgroup-parent"),
                    string(field(fields, "cgroupParent"))?,
                ],
            );
        }
        for mount in crate::worker_launch::mounts(config.source())
            .map_err(|_| NixDataError::Configuration)?
        {
            if mount.read_only()
                && ["/etc/passwd", "/etc/group"].iter().any(|v| {
                    mount
                        .destination()
                        .codepoints()
                        .iter()
                        .copied()
                        .eq(v.chars().map(u32::from))
                })
            {
                arguments.splice(
                    1..1,
                    [
                        MetadataText::from_scalar_text("--mount"),
                        join(&[
                            &MetadataText::from_scalar_text("type=bind,src="),
                            mount.source(),
                            &MetadataText::from_scalar_text(",dst="),
                            mount.destination(),
                            &MetadataText::from_scalar_text(",readonly"),
                        ]),
                    ],
                );
            }
        }
        Ok(Self { name, arguments })
    }
    pub fn name(&self) -> &MetadataText {
        &self.name
    }
    pub fn arguments(&self) -> &[MetadataText] {
        &self.arguments
    }
}
fn equal(value: Option<&Value>, expected: &str) -> bool {
    matches!(value,Some(Value(Node::String(value))) if value.equals_ascii(expected))
}
fn texts(values: &[&str]) -> Vec<MetadataText> {
    values
        .iter()
        .map(|v| MetadataText::from_scalar_text(v))
        .collect()
}
fn prefix(prefix: &str, value: &MetadataText) -> MetadataText {
    join(&[&MetadataText::from_scalar_text(prefix), value])
}
fn join(values: &[&MetadataText]) -> MetadataText {
    MetadataText::from_python_text(
        reverie_core::PythonText::try_new(
            values
                .iter()
                .flat_map(|v| v.codepoints().iter().copied())
                .collect(),
        )
        .expect("checked text codepoints"),
    )
}
