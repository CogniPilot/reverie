//! Complete selected image fields and program graph DATA. Native callers must
//! obtain the exact immutable bytes and actual daemon response independently.
mod installation;
mod startup;
#[cfg(test)]
mod tests;
use super::*;
pub use startup::{InvocationKind, InvocationSelection, WebsiteProgramGraph};

pub struct WebsiteImageProvenance {
    archive: JournalDigest,
    image: Value,
    console: PythonText,
    node: ProgramSelection,
    client: ArtifactReference,
    startup: Option<ArtifactReference>,
    code: Vec<CodeFile>,
}
impl WebsiteImageProvenance {
    /// Fixed manifest DATA only; native process/file custody is independent.
    pub fn node_prefix(&self) -> &ProgramSelection {
        &self.node
    }
    pub fn decode(raw: &[u8]) -> Result<Self> {
        need(
            !raw.is_empty() && raw.len() <= 65536,
            "RESOURCE_INSTALL_ARTIFACT_BOUND",
        )?;
        let value = legacy_json::decode_strict_bytes(raw)
            .map_err(|_| ResourceActorDataError("RESOURCE_INSTALL_ARTIFACT_PURPOSE"))?;
        closed(
            &value,
            &[
                "version",
                "purpose",
                "archiveConfigSHA256",
                "imageSpec",
                "console",
                "node",
                "clientManifest",
                "codeFiles",
                "startupManifest",
            ],
        )?;
        need(
            matches!(&field(&value, "version")?.0, Node::Number(Number::Integer(v)) if v == "1")
                && matches!(&field(&value, "purpose")?.0, Node::String(v) if v.equals_ascii("website-image-provenance-v1")),
            "RESOURCE_INSTALL_ARTIFACT_PURPOSE",
        )?;
        let node = field(&value, "node")?;
        closed(node, &["executable", "argvPrefix"])?;
        let argv = array(field(node, "argvPrefix")?)?
            .iter()
            .map(text)
            .collect::<Result<Vec<_>>>()?;
        need(
            (2..=32).contains(&argv.len()),
            "RESOURCE_INSTALL_FIXED_NODE",
        )?;
        let startup = match &field(&value, "startupManifest")?.0 {
            Node::Null => None,
            _ => Some(ArtifactReference::decode(field(
                &value,
                "startupManifest",
            )?)?),
        };
        let output = Self {
            archive: digest(field(&value, "archiveConfigSHA256")?)?,
            image: field(&value, "imageSpec")?.deep_clone(),
            console: text(field(&value, "console")?)?,
            node: ProgramSelection {
                executable: text(field(node, "executable")?)?,
                argv,
            },
            client: ArtifactReference::decode(field(&value, "clientManifest")?)?,
            startup,
            code: website::files(field(&value, "codeFiles")?)?,
        };
        if output.startup.is_none() {
            let mut entry = output.console.codepoints().to_vec();
            entry.extend("/lib/reverie/dist/index.js".chars().map(u32::from));
            need(
                output.node.argv.len() == 2 && output.node.argv[1].codepoints() == entry,
                "RESOURCE_INSTALL_FIXED_NODE",
            )?;
        }
        for name in ["Config", "RootFS", "Architecture", "Os"] {
            field(&output.image, name)?;
        }
        creation(field(&output.image, "Created")?)?;
        Ok(output)
    }
    pub fn startup_reference(&self) -> Option<&ArtifactReference> {
        self.startup.as_ref()
    }
    pub fn client_reference(&self) -> &ArtifactReference {
        &self.client
    }
    pub fn code_files(&self) -> &[CodeFile] {
        &self.code
    }
    /// Only the program selections, not startup alias resolution, immutable
    /// file custody, process identity or owner approval. Startup graph checks
    /// must additionally consume the selected startup manifest when present.
    pub fn require_installation(
        &self,
        installed: &InstalledFactsDocument,
        client: &NativeResourceClientManifest,
    ) -> Result<()> {
        need(
            installed.client == self.client
                && installed.website.code == self.code
                && installed.website.node.executable == self.node.executable
                && installed.website.node.argv.starts_with(&self.node.argv)
                && installed.website.bootstrap.executable == *client.executable()
                && installed.website.bootstrap.argv == [client.executable().clone()],
            "RESOURCE_INSTALL_PROGRAM_BINDING",
        )
    }
}
impl EngineMetadata {
    /// Matches full expected image fields, aware creation instant and native
    /// descriptor/config identity. A returned ID remains daemon-declared DATA.
    pub fn qualify_image(&self, selected: &WebsiteImageProvenance) -> Result<String> {
        self.qualify_image_fields(&selected.archive, &selected.image)
    }
    pub(super) fn qualify_image_fields(
        &self,
        archive: &JournalDigest,
        image: &Value,
    ) -> Result<String> {
        let id = scalar(field(&self.0, "Id")?)?;
        need(
            id.strip_prefix("sha256:")
                .is_some_and(|value| JournalDigest::parse(value).is_ok()),
            "NATIVE_IMAGE_IDENTITY_REQUIRED",
        )?;
        for name in ["Config", "RootFS", "Architecture", "Os"] {
            need(
                field(&self.0, name)?.python_eq(field(image, name)?),
                "NATIVE_FULL_IMAGE_FIELDS_DIFFER",
            )?;
        }
        need(
            creation(field(&self.0, "Created")?)? == creation(field(image, "Created")?)?,
            "NATIVE_IMAGE_CREATION_DIFFERS",
        )?;
        let descriptor = object(&self.0)?.get(&key("Descriptor"));
        if descriptor.is_none_or(|value| matches!(value.0, Node::Null)) {
            need(
                id == format!("sha256:{}", archive.as_str()),
                "LEGACY_IMAGE_CONFIG_IDENTITY_DIFFERS",
            )?;
        } else {
            let descriptor = descriptor.expect("non-null descriptor");
            need(
                scalar(field(descriptor, "digest")?)? == id
                    && [
                        "application/vnd.docker.distribution.manifest.v2+json",
                        "application/vnd.oci.image.manifest.v1+json",
                    ]
                    .contains(&scalar(field(descriptor, "mediaType")?)?.as_str()),
                "NATIVE_IMAGE_MANIFEST_IDENTITY_DIFFERS",
            )?;
        }
        Ok(id)
    }
}
fn creation(value: &Value) -> Result<i128> {
    image_time::instant(text(value)?.codepoints())
        .ok_or(ResourceActorDataError("IMAGE_CREATION_INSTANT_REQUIRED"))
}
