//! Closed symbolic startup graph DATA. Every returned alias still needs native
//! host/guest resolution, immutable code and actual program/peer verification.
use super::*;
use sha2::{Digest, Sha256};
pub enum InvocationKind {
    Executable,
    ManifestedArgument,
    LegacyPython,
}
pub struct InvocationSelection {
    invocation: PythonText,
    executable: Option<PythonText>,
    kind: InvocationKind,
}
impl InvocationSelection {
    pub fn invocation(&self) -> &PythonText {
        &self.invocation
    }
    pub fn executable(&self) -> Option<&PythonText> {
        self.executable.as_ref()
    }
    pub fn kind(&self) -> &InvocationKind {
        &self.kind
    }
}
pub struct WebsiteProgramGraph {
    invocations: Vec<InvocationSelection>,
    startup_code: Vec<CodeFile>,
}
impl WebsiteProgramGraph {
    pub fn invocations(&self) -> &[InvocationSelection] {
        &self.invocations
    }
    /// Legacy startup invocation targets must be in this exact subset, not
    /// merely somewhere in the larger image manifest. Still DATA only.
    pub fn startup_code_files(&self) -> &[CodeFile] {
        &self.startup_code
    }
}
impl WebsiteImageProvenance {
    /// Both immutable input readers and actual alias/code observations are
    /// factory obligations. This validates only the complete symbolic graph,
    /// exact manifest bytes/digest and installed program selections.
    pub fn program_graph(
        &self,
        installed: &InstalledFactsDocument,
        client: &NativeResourceClientManifest,
        startup: Option<&[u8]>,
    ) -> Result<WebsiteProgramGraph> {
        self.require_installation(installed, client)?;
        need(
            self.code.iter().any(|code| {
                code.path == *client.executable() && code.sha256 == *client.executable_digest()
            }),
            "RESOURCE_INSTALL_PROGRAM_BINDING",
        )?;
        let mut invocations = vec![
            InvocationSelection {
                invocation: installed.website.node.argv[0].clone(),
                executable: Some(self.node.executable.clone()),
                kind: InvocationKind::Executable,
            },
            InvocationSelection {
                invocation: client.executable().clone(),
                executable: Some(client.executable().clone()),
                kind: InvocationKind::Executable,
            },
        ];
        for program in [&installed.website.node, &installed.website.bootstrap] {
            require_path(&program.executable)?;
            need(
                self.code.iter().any(|code| code.path == program.executable),
                "UNMANIFESTED_BACKEND_CODE",
            )?;
            for argument in program.argv.iter().skip(1).filter(|value| is_store(value)) {
                invocations.push(InvocationSelection {
                    invocation: argument.clone(),
                    executable: None,
                    kind: InvocationKind::ManifestedArgument,
                });
            }
        }
        let mut startup_code = Vec::new();
        match (&self.startup, startup) {
            (None, None) => {}
            (Some(selected), Some(raw)) => {
                need(
                    !raw.is_empty()
                        && raw.len() <= 65536
                        && JournalDigest::parse(&format!("{:x}", Sha256::digest(raw)))
                            .expect("SHA256")
                            == selected.sha256,
                    "RESOURCE_INSTALL_STARTUP_GRAPH_CHANGED",
                )?;
                let (selected, code) = startup_graph(self, raw)?;
                invocations.extend(selected);
                startup_code = code;
            }
            _ => {
                return Err(ResourceActorDataError(
                    "RESOURCE_INSTALL_STARTUP_GRAPH_REQUIRED",
                ));
            }
        }
        for selected in &invocations {
            require_path(&selected.invocation)?;
            if let Some(executable) = &selected.executable {
                require_path(executable)?;
            }
        }
        Ok(WebsiteProgramGraph {
            invocations,
            startup_code,
        })
    }
}
fn startup_graph(
    image: &WebsiteImageProvenance,
    raw: &[u8],
) -> Result<(Vec<InvocationSelection>, Vec<CodeFile>)> {
    let value = legacy_json::decode_strict_bytes(raw)
        .map_err(|_| ResourceActorDataError("RESOURCE_INSTALL_STARTUP_GRAPH_CHANGED"))?;
    closed(
        &value,
        &[
            "version",
            "purpose",
            "nodeInvocation",
            "nodeExecutable",
            "nodeWrapper",
            "applicationEntry",
            "argvPrefix",
            "startupPython",
            "normalEntrypoint",
            "codeFiles",
        ],
    )?;
    need(
        matches!(&field(&value,"version")?.0, Node::Number(Number::Integer(v)) if v == "1")
            && matches!(&field(&value,"purpose")?.0, Node::String(v) if v.equals_ascii("owner-terminal-website-program-v1")),
        "RESOURCE_INSTALL_STARTUP_GRAPH_CHANGED",
    )?;
    let prefix = arguments(field(&value, "argvPrefix")?)?;
    let invocation = text(field(&value, "nodeInvocation")?)?;
    let wrapper = text(field(&value, "nodeWrapper")?)?;
    let executable = text(field(&value, "nodeExecutable")?)?;
    let entry = text(field(&value, "applicationEntry")?)?;
    let mut expected_entry = image.console.codepoints().to_vec();
    expected_entry.extend("/lib/reverie/dist/index.js".chars().map(u32::from));
    need(
        prefix.len() >= 2
            && prefix[..2] == [invocation.clone(), wrapper.clone()]
            && prefix == image.node.argv
            && executable == image.node.executable
            && entry.codepoints() == expected_entry,
        "RESOURCE_INSTALL_FIXED_NODE",
    )?;
    let code = website::files(field(&value, "codeFiles")?)?;
    need(
        code.iter().all(|selected| image.code.contains(selected)),
        "RESOURCE_INSTALL_STARTUP_CODE_CHANGED",
    )?;
    let mut required = vec![
        executable.clone(),
        wrapper,
        entry,
        text(field(&value, "normalEntrypoint")?)?,
    ];
    let python = python_graph(field(&value, "startupPython")?, &mut required)?;
    for path in &required {
        require_path(path)?;
        need(
            code.iter().any(|selected| &selected.path == path),
            "INCOMPLETE_STARTUP_CODE_GRAPH",
        )?;
    }
    Ok((
        vec![
            InvocationSelection {
                invocation,
                executable: Some(executable),
                kind: InvocationKind::Executable,
            },
            python,
        ],
        code,
    ))
}
fn python_graph(value: &Value, required: &mut Vec<PythonText>) -> Result<InvocationSelection> {
    // Read legacy startup metadata during transition; never execute Python.
    closed(
        value,
        &[
            "invocation",
            "executable",
            "entry",
            "bootstrapModule",
            "packageInit",
            "argvPrefix",
        ],
    )?;
    let invocation = text(field(value, "invocation")?)?;
    let executable = text(field(value, "executable")?)?;
    let entry = text(field(value, "entry")?)?;
    let args = arguments(field(value, "argvPrefix")?)?;
    need(
        args.len() >= 3
            && args[..3]
                == [
                    invocation.clone(),
                    PythonText::from_scalar_text("-I"),
                    entry.clone(),
                ],
        "FIXED_STARTUP_PYTHON_GRAPH_REQUIRED",
    )?;
    required.extend([
        executable.clone(),
        entry,
        text(field(value, "bootstrapModule")?)?,
        text(field(value, "packageInit")?)?,
    ]);
    // Native resolution must additionally require the invocation's resolved
    // target in this same code manifest; the spelling may be a fixed Nix alias.
    Ok(InvocationSelection {
        invocation,
        executable: Some(executable),
        kind: InvocationKind::LegacyPython,
    })
}
fn arguments(value: &Value) -> Result<Vec<PythonText>> {
    let values = array(value)?.iter().map(text).collect::<Result<Vec<_>>>()?;
    need(
        (1..=32).contains(&values.len())
            && values.iter().all(|value| {
                !value.codepoints().is_empty()
                    && value.codepoints().len() <= 4096
                    && !value.codepoints().contains(&0)
            }),
        "FIXED_STARTUP_ARGUMENTS_REQUIRED",
    )?;
    Ok(values)
}
fn require_path(value: &PythonText) -> Result<()> {
    let path = reverie_core::posix_path::PosixPath::try_new(value.codepoints())
        .map_err(|_| ResourceActorDataError("FIXED_STARTUP_CODE_PATH"))?;
    need(
        is_store(value)
            && path.codepoints() == value.codepoints()
            && !path.has_parent_component()
            && !value.codepoints().contains(&0),
        "FIXED_STARTUP_CODE_PATH",
    )
}
fn is_store(value: &PythonText) -> bool {
    value
        .codepoints()
        .starts_with(&"/nix/store/".chars().map(u32::from).collect::<Vec<_>>())
}
