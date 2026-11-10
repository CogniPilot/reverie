//! Fixed Nix producer DATA only. No filesystem, archive extraction, installed
//! custody, running-image acceptance, process execution or owner authority.
mod archive;
mod protected;
mod startup;
mod worker;
use super::*;
pub use archive::{WebsiteArchiveConfiguration, WebsiteArchiveManifest};
pub use startup::WebsiteStartupBuildGraph;
pub use worker::{HUMAN_TERMINAL_FILES, WORKER_IMAGE_V1_FACTORY_FILES, WorkerImageProvenanceBuild};

pub struct WebsiteProvenanceBuild {
    archive: WebsiteArchiveConfiguration,
    console: PythonText,
    node: ProgramSelection,
    client: ArtifactReference,
    startup: Option<ArtifactReference>,
    code: BTreeMap<Text, Value>,
}
impl WebsiteProvenanceBuild {
    /// File pins are observations supplied by the fixed build tool, never
    /// native proof. Its caller must independently read every selected file.
    pub fn new(
        archive: WebsiteArchiveConfiguration,
        console: PythonText,
        node: ProgramSelection,
        client: ArtifactReference,
        code: &[CodeFile],
    ) -> Result<Self> {
        let mut output = Self {
            archive,
            console,
            node,
            client,
            startup: None,
            code: BTreeMap::new(),
        };
        for pin in code {
            output.insert_code(pin)?;
        }
        Ok(output)
    }
    pub fn include_startup(
        &mut self,
        graph: WebsiteStartupBuildGraph,
        reference: ArtifactReference,
    ) -> Result<()> {
        need(
            self.startup.is_none(),
            "WEBSITE_BUILD_STARTUP_ALREADY_SELECTED",
        )?;
        for pin in graph.code_files() {
            self.insert_code(pin)?;
        }
        self.node.argv = graph.argv;
        self.startup = Some(reference);
        Ok(())
    }
    fn insert_code(&mut self, pin: &CodeFile) -> Result<()> {
        let key = Text(pin.path.codepoints().to_vec());
        let value = pin_value(pin);
        need(
            self.code.get(&key).is_none_or(|old| old.python_eq(&value)),
            "WEBSITE_BUILD_CONFLICTING_CODE_GRAPH",
        )?;
        self.code.insert(key, value);
        Ok(())
    }
    /// Preserve Python's sorted, compact, ensure_ascii encoder, including
    /// unknown Config values, arbitrary integers, floats and lone surrogates.
    pub fn encode(&self) -> Vec<u8> {
        let value = fields([
            ("version", integer(1)),
            ("purpose", string("website-image-provenance-v1")),
            ("archiveConfigSHA256", string(self.archive.digest.as_str())),
            ("imageSpec", self.archive.image.deep_clone()),
            ("console", python_string(&self.console)),
            (
                "node",
                fields([
                    ("executable", python_string(&self.node.executable)),
                    (
                        "argvPrefix",
                        Value(Node::Array(
                            self.node.argv.iter().map(python_string).collect(),
                        )),
                    ),
                ]),
            ),
            ("clientManifest", reference_value(&self.client)),
            (
                "startupManifest",
                self.startup
                    .as_ref()
                    .map_or(Value(Node::Null), reference_value),
            ),
            (
                "codeFiles",
                Value(Node::Object(
                    self.code
                        .iter()
                        .map(|(k, v)| (k.clone(), v.deep_clone()))
                        .collect(),
                )),
            ),
        ]);
        let mut bytes = crate::worker_config::compact_data(&value);
        bytes.push(b'\n');
        bytes
    }
}
fn decode(raw: &[u8], maximum: usize) -> Result<Value> {
    need(
        !raw.is_empty() && raw.len() <= maximum,
        "WEBSITE_BUILD_DOCUMENT_BOUND",
    )?;
    legacy_json::decode_strict_bytes(raw)
        .map_err(|_| ResourceActorDataError("WEBSITE_BUILD_DUPLICATE_OR_INVALID_JSON"))
}
fn string(value: &str) -> Value {
    python_string(&PythonText::from_scalar_text(value))
}
fn python_string(value: &PythonText) -> Value {
    Value(Node::String(Text(value.codepoints().to_vec())))
}
fn integer(value: u64) -> Value {
    Value(Node::Number(Number::Integer(value.to_string())))
}
fn fields<const N: usize>(values: [(&str, Value); N]) -> Value {
    Value(Node::Object(
        values
            .into_iter()
            .map(|(name, value)| (key(name), value))
            .collect(),
    ))
}
fn pin_value(pin: &CodeFile) -> Value {
    fields([
        ("sha256", string(pin.sha256.as_str())),
        ("bytes", integer(pin.bytes)),
    ])
}
fn reference_value(reference: &ArtifactReference) -> Value {
    fields([
        ("path", python_string(&reference.path)),
        ("sha256", string(reference.sha256.as_str())),
    ])
}
