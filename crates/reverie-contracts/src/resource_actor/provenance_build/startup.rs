use super::*;
use reverie_core::posix_path::PosixPath;

pub struct WebsiteStartupBuildGraph {
    pub(super) argv: Vec<PythonText>,
    node_invocation: PythonText,
    python_invocation: PythonText,
    python_executable: PythonText,
    code: Vec<CodeFile>,
    required: Vec<PythonText>,
}
impl WebsiteStartupBuildGraph {
    pub fn decode(raw: &[u8], console: &PythonText, node: &PythonText) -> Result<Self> {
        let value = decode(raw, 65536)?;
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
            unsigned(field(&value, "version")?)?.as_str() == "1"
                && scalar(field(&value, "purpose")?)? == "owner-terminal-website-program-v1",
            "WEBSITE_BUILD_STARTUP_SCHEMA",
        )?;
        let argv = array(field(&value, "argvPrefix")?)?
            .iter()
            .map(text)
            .collect::<Result<Vec<_>>>()?;
        let invocation = text(field(&value, "nodeInvocation")?)?;
        let wrapper = text(field(&value, "nodeWrapper")?)?;
        let executable = text(field(&value, "nodeExecutable")?)?;
        let entry = text(field(&value, "applicationEntry")?)?;
        let mut expected_entry = console.codepoints().to_vec();
        expected_entry.extend("/lib/reverie/dist/index.js".chars().map(u32::from));
        need(
            (2..=32).contains(&argv.len())
                && argv.iter().all(|v| {
                    !v.codepoints().is_empty()
                        && v.codepoints().len() <= 4096
                        && !v.codepoints().contains(&0)
                })
                && argv[..2] == [invocation.clone(), wrapper.clone()]
                && executable == *node
                && entry.codepoints() == expected_entry,
            "WEBSITE_BUILD_FIXED_NODE_GRAPH",
        )?;
        let mut required = vec![
            executable,
            wrapper,
            entry,
            text(field(&value, "normalEntrypoint")?)?,
        ];
        let (python_invocation, python_executable) =
            python(field(&value, "startupPython")?, &mut required)?;
        let code = code_files(field(&value, "codeFiles")?)?;
        need(
            required
                .iter()
                .all(|path| code.iter().any(|pin| pin.path == *path)),
            "WEBSITE_BUILD_INCOMPLETE_STARTUP_GRAPH",
        )?;
        Ok(Self {
            argv,
            node_invocation: invocation,
            python_invocation,
            python_executable,
            code,
            required,
        })
    }
    pub fn node_invocation(&self) -> &PythonText {
        &self.node_invocation
    }
    pub fn python_invocation(&self) -> &PythonText {
        &self.python_invocation
    }
    pub fn python_executable(&self) -> &PythonText {
        &self.python_executable
    }
    pub fn code_files(&self) -> &[CodeFile] {
        &self.code
    }
    /// Resolutions are actual observations by the fixed build tool, not
    /// authority supplied by a request or a substitute for immutable reads.
    pub fn require_resolutions(&self, node: &PythonText, python: &PythonText) -> Result<()> {
        need(
            self.required.first() == Some(node) && self.code.iter().any(|pin| pin.path == *python),
            "WEBSITE_BUILD_STARTUP_ALIAS_GRAPH",
        )
    }
}
fn python(value: &Value, required: &mut Vec<PythonText>) -> Result<(PythonText, PythonText)> {
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
    let invocation_path = PosixPath::try_new(invocation.codepoints())
        .map_err(|_| ResourceActorDataError("WEBSITE_BUILD_CODE_PATH"))?;
    need(
        invocation_path.is_absolute()
            && !invocation_path.has_parent_component()
            && invocation_path.is_relative_to(&PosixPath::from_scalar_text("/nix/store")),
        "WEBSITE_BUILD_CODE_PATH",
    )?;
    store_path(&executable)?;
    let argv = array(field(value, "argvPrefix")?)?;
    let entry = field(value, "entry")?;
    need(
        argv.len() >= 3
            && argv[0].python_eq(&python_string(&invocation))
            && argv[1].python_eq(&string("-I"))
            && argv[2].python_eq(entry),
        "WEBSITE_BUILD_STARTUP_PYTHON_GRAPH",
    )?;
    required.extend([
        executable.clone(),
        text(entry)?,
        text(field(value, "bootstrapModule")?)?,
        text(field(value, "packageInit")?)?,
    ]);
    Ok((invocation, executable))
}
fn code_files(value: &Value) -> Result<Vec<CodeFile>> {
    let files = object(value)?;
    need(
        (1..=4096).contains(&files.len()),
        "WEBSITE_BUILD_CODE_MANIFEST_BOUND",
    )?;
    let mut total = 0_u64;
    let mut output = Vec::new();
    for (path, pin) in files {
        let path = PythonText::try_new(path.0.clone()).expect("JSON codepoints");
        store_path(&path)?;
        closed(pin, &["sha256", "bytes"])?;
        let bytes = unsigned(field(pin, "bytes")?)?
            .to_u64()
            .ok_or(ResourceActorDataError("WEBSITE_BUILD_CODE_BOUND"))?;
        total = total
            .checked_add(bytes)
            .ok_or(ResourceActorDataError("WEBSITE_BUILD_CODE_BOUND"))?;
        need(
            bytes <= 256 << 20 && total <= 512 << 20,
            "WEBSITE_BUILD_CODE_BOUND",
        )?;
        output.push(CodeFile {
            path,
            sha256: digest(field(pin, "sha256")?)?,
            bytes,
        });
    }
    Ok(output)
}
fn store_path(value: &PythonText) -> Result<()> {
    let path = PosixPath::try_new(value.codepoints())
        .map_err(|_| ResourceActorDataError("WEBSITE_BUILD_CODE_PATH"))?;
    need(
        path.codepoints() == value.codepoints()
            && !path.has_parent_component()
            && value
                .codepoints()
                .starts_with(&"/nix/store/".chars().map(u32::from).collect::<Vec<_>>()),
        "WEBSITE_BUILD_CODE_PATH",
    )
}
