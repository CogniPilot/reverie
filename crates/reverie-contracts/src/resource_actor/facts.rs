use super::*;
mod rebind;

/// Installer-selected references, never request-selected executable authority.
#[derive(Clone, Eq, PartialEq)]
pub struct ArtifactReference {
    pub path: PythonText,
    pub sha256: JournalDigest,
}
impl ArtifactReference {
    pub(super) fn decode(value: &Value) -> Result<Self> {
        closed(value, &["path", "sha256"])?;
        Ok(Self {
            path: text(field(value, "path")?)?,
            sha256: digest(field(value, "sha256")?)?,
        })
    }
}
pub struct EngineSelection {
    pub socket: PythonText,
    pub identity: [UnsignedInteger; 4],
    pub id: String,
}
impl EngineSelection {
    fn decode(value: &Value) -> Result<Self> {
        closed(value, &["socket", "identity", "id"])?;
        let socket = text(field(value, "socket")?)?;
        let path = reverie_core::posix_path::PosixPath::try_new(socket.codepoints())
            .map_err(|_| ResourceActorDataError("ENGINE_SOCKET_PATH"))?;
        need(
            path.is_absolute() && !path.components().any(|part| part == [46, 46]),
            "ENGINE_SOCKET_PATH",
        )?;
        let identity = array(field(value, "identity")?)?
            .iter()
            .map(unsigned)
            .collect::<Result<Vec<_>>>()?
            .try_into()
            .map_err(|_| ResourceActorDataError("ENGINE_SOCKET_IDENTITY"))?;
        let id = scalar(field(value, "id")?)?;
        need(
            !id.is_empty() && id.chars().count() <= 200,
            "ENGINE_ID_REQUIRED",
        )?;
        Ok(Self {
            socket,
            identity,
            id,
        })
    }
}
pub struct InstalledFactsDocument {
    pub configuration_digest: JournalDigest,
    pub engine: EngineSelection,
    pub website: WebsiteSelection,
    pub provenance: ArtifactReference,
    pub client: ArtifactReference,
}
impl InstalledFactsDocument {
    /// Only parses the existing private document. Does not open a reference,
    /// inspect an engine, authenticate a process, or create any native owner.
    pub fn decode(raw: &[u8]) -> Result<Self> {
        need(raw.len() <= 65536, "RESOURCE_INSTALL_ARTIFACT_BOUND")?;
        let value = legacy_json::decode_strict_bytes(raw)
            .map_err(|_| ResourceActorDataError("RESOURCE_INSTALL_CLOSED_SCHEMA"))?;
        closed(
            &value,
            &[
                "version",
                "purpose",
                "configurationDigest",
                "engine",
                "website",
                "imageProvenance",
                "client",
            ],
        )?;
        need(
            matches!(&field(&value, "version")?.0, Node::Number(Number::Integer(version)) if version == "2")
                && matches!(&field(&value, "purpose")?.0, Node::String(purpose) if purpose.equals_ascii(PURPOSE)),
            "RESOURCE_INSTALL_DOMAIN",
        )?;
        Ok(Self {
            configuration_digest: digest(field(&value, "configurationDigest")?)?,
            engine: EngineSelection::decode(field(&value, "engine")?)?,
            website: WebsiteSelection::decode(field(&value, "website")?)?,
            provenance: ArtifactReference::decode(field(&value, "imageProvenance")?)?,
            client: ArtifactReference::decode(field(&value, "client")?)?,
        })
    }
}
