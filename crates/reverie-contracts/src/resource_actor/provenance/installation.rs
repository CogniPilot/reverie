//! Initial facts DATA only; native custody and publication are independent.
use super::*;
impl WebsiteImageProvenance {
    pub fn initial_installation_document(
        &self,
        configuration_digest: JournalDigest,
        engine: EngineSelection,
        website: WebsiteSelection,
        provenance: ArtifactReference,
        client: &NativeResourceClientManifest,
    ) -> Result<InstalledFactsDocument> {
        let document = InstalledFactsDocument {
            configuration_digest,
            engine,
            website,
            provenance,
            client: self.client.clone(),
        };
        self.require_installation(&document, client)?;
        Ok(document)
    }
}
impl InstalledFactsDocument {
    pub fn configuration_bytes(&self) -> Result<Vec<u8>> {
        let engine = mapping(vec![
            ("socket", text_data(&self.engine.socket)),
            (
                "identity",
                Value(Node::Array(
                    self.engine.identity.iter().map(integer).collect(),
                )),
            ),
            ("id", string(&self.engine.id)),
        ]);
        let raw = crate::worker_config::compact_data(&mapping(vec![
            ("version", integer(&UnsignedInteger::from_u64(2))),
            ("purpose", string(PURPOSE)),
            (
                "configurationDigest",
                string(self.configuration_digest.as_str()),
            ),
            ("engine", engine),
            ("website", website(&self.website)),
            ("imageProvenance", artifact(&self.provenance)),
            ("client", artifact(&self.client)),
        ]));
        Self::decode(&raw)?;
        Ok(raw)
    }
}
fn website(value: &WebsiteSelection) -> Value {
    let code = Value(Node::Object(
        value
            .code
            .iter()
            .map(|value| {
                (
                    Text(value.path.codepoints().to_vec()),
                    mapping(vec![
                        ("sha256", string(value.sha256.as_str())),
                        ("bytes", integer(&UnsignedInteger::from_u64(value.bytes))),
                    ]),
                )
            })
            .collect(),
    ));
    let (pid, start) = value
        .initial
        .as_ref()
        .map_or((Value(Node::Null), Value(Node::Null)), |(pid, start)| {
            (integer(pid), integer(start))
        });
    mapping(vec![
        ("containerId", string(value.container.as_str())),
        ("imageId", string(&value.image)),
        ("configDigest", string(value.config_digest.as_str())),
        (
            "hostConfigDigest",
            string(value.host_config_digest.as_str()),
        ),
        ("mountsDigest", string(value.mounts_digest.as_str())),
        ("initPid", pid),
        ("initStart", start),
        (
            "uid",
            integer(&UnsignedInteger::from_u64(u64::from(value.uid))),
        ),
        (
            "gid",
            integer(&UnsignedInteger::from_u64(u64::from(value.gid))),
        ),
        ("bootstrap", program(&value.bootstrap)),
        ("node", program(&value.node)),
        ("codeFiles", code),
    ])
}
fn program(value: &ProgramSelection) -> Value {
    mapping(vec![
        ("executable", text_data(&value.executable)),
        (
            "argv",
            Value(Node::Array(value.argv.iter().map(text_data).collect())),
        ),
    ])
}
fn artifact(value: &ArtifactReference) -> Value {
    mapping(vec![
        ("path", text_data(&value.path)),
        ("sha256", string(value.sha256.as_str())),
    ])
}
fn text_data(value: &PythonText) -> Value {
    Value(Node::String(Text(value.codepoints().to_vec())))
}
fn string(value: &str) -> Value {
    text_data(&PythonText::from_scalar_text(value))
}
fn integer(value: &UnsignedInteger) -> Value {
    Value(Node::Number(Number::Integer(value.as_str().to_owned())))
}
fn mapping(values: Vec<(&str, Value)>) -> Value {
    Value(Node::Object(
        values
            .into_iter()
            .map(|(name, value)| (key(name), value))
            .collect(),
    ))
}
