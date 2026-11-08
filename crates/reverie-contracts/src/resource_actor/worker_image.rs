//! Worker factory/native child DATA. Native immutable input, actual engine,
//! stopped-service and admitted maintenance owners remain independently required.
use super::*;
mod factory;
pub struct WorkerImageProvenance {
    archive: JournalDigest,
    image: Value,
    child: Value,
    program: CodeFile,
    manifest: CodeFile,
    toolkit: Vec<CodeFile>,
}
impl WorkerImageProvenance {
    pub fn decode(base: &ArtifactReference, raw: &[u8], annex: &[u8]) -> Result<Self> {
        use sha2::{Digest, Sha256};
        let before = decode(raw)?;
        let after = decode(annex)?;
        closed(
            &before,
            &[
                "version",
                "purpose",
                "archiveConfigSHA256",
                "imageSpec",
                "archive",
                "factory",
                "source",
                "toolkit",
            ],
        )?;
        closed(
            &after,
            &[
                "version",
                "purpose",
                "baseProvenance",
                "archiveConfigSHA256",
                "imageSpec",
                "archive",
                "factory",
                "workerChild",
            ],
        )?;
        purpose(&before, "worker-image-provenance-v1")?;
        purpose(&after, "worker-child-image-v1")?;
        let base_pin = code(field(&after, "baseProvenance")?)?;
        need(
            base_pin.path == base.path
                && base_pin.sha256 == base.sha256
                && base_pin.bytes == raw.len() as u64
                && format!("{:x}", Sha256::digest(raw)) == base.sha256.as_str(),
            "WORKER_IMAGE_BASE_BINDING",
        )?;
        for name in ["archiveConfigSHA256", "imageSpec", "archive", "factory"] {
            need(
                field(&before, name)?.python_eq(field(&after, name)?),
                "WORKER_IMAGE_CONSTRUCTION_BINDING",
            )?;
        }
        code(field(&before, "archive")?)?;
        factory::validate(field(&before, "factory")?, field(&before, "imageSpec")?)?;
        factory::validate(field(&after, "factory")?, field(&after, "imageSpec")?)?;
        let toolkit = factory::toolkit(field(&before, "toolkit")?)?;
        let source = field(&before, "source")?;
        closed(source, &["path", "factoryFiles"])?;
        need(
            scalar(field(source, "path")?)?.starts_with("/nix/store/"),
            "WORKER_IMAGE_SOURCE",
        )?;
        need(
            !object(field(source, "factoryFiles")?)?.is_empty(),
            "WORKER_IMAGE_SOURCE",
        )?;
        for value in object(field(source, "factoryFiles")?)?.values() {
            closed(value, &["sha256", "bytes"])?;
            digest(field(value, "sha256")?)?;
            need(
                unsigned(field(value, "bytes")?)?
                    .to_u64()
                    .is_some_and(|v| v > 0),
                "WORKER_IMAGE_SOURCE",
            )?;
        }
        let child = field(&after, "workerChild")?;
        closed(
            child,
            &[
                "version",
                "purpose",
                "abi",
                "program",
                "elfMachine",
                "manifest",
            ],
        )?;
        program(child, field(&after, "factory")?)?;
        let manifest = code(field(child, "manifest")?)?;
        let labels = field(field(field(&after, "imageSpec")?, "Config")?, "Labels")?;
        need(
            text(field(labels, "org.reverie.worker.child-manifest")?)? == manifest.path,
            "WORKER_IMAGE_MANIFEST_BINDING",
        )?;
        Ok(Self {
            archive: digest(field(&before, "archiveConfigSHA256")?)?,
            image: field(&before, "imageSpec")?.deep_clone(),
            child: child.deep_clone(),
            program: code(field(child, "program")?)?,
            manifest,
            toolkit,
        })
    }
    pub fn program(&self) -> &CodeFile {
        &self.program
    }
    pub fn manifest(&self) -> &CodeFile {
        &self.manifest
    }
    pub fn toolkit(&self) -> &[CodeFile] {
        &self.toolkit
    }
    pub fn require_identity(&self, ids: reverie_core::worker_schema::WorkerIds) -> Result<()> {
        need(
            scalar(field(field(&self.image, "Config")?, "User")?)?
                == format!("{}:{}", ids.uid(), ids.gid()),
            "WORKER_IMAGE_CONFIG_IDENTITY",
        )
    }
    pub fn require_program_manifest(&self, raw: &[u8]) -> Result<()> {
        let value = decode(raw)?;
        closed(
            &value,
            &["version", "purpose", "abi", "program", "elfMachine"],
        )?;
        purpose(&value, "worker-child-program-v1")?;
        for name in ["version", "purpose", "abi", "program", "elfMachine"] {
            need(
                field(&value, name)?.python_eq(field(&self.child, name)?),
                "WORKER_IMAGE_PROGRAM_BINDING",
            )?;
        }
        // Native immutable reader separately proves the selected manifest hash.
        use sha2::{Digest, Sha256};
        need(
            raw.len() as u64 == self.manifest.bytes
                && format!("{:x}", Sha256::digest(raw)) == self.manifest.sha256.as_str(),
            "WORKER_IMAGE_PROGRAM_BINDING",
        )
    }
}
impl EngineMetadata {
    pub fn qualify_worker_image(&self, selected: &WorkerImageProvenance) -> Result<String> {
        self.qualify_image_fields(&selected.archive, &selected.image)
    }
}
fn decode(raw: &[u8]) -> Result<Value> {
    need(
        !raw.is_empty() && raw.len() <= 65536,
        "WORKER_IMAGE_PROFILE_BOUND",
    )?;
    legacy_json::decode_strict_bytes(raw)
        .map_err(|_| ResourceActorDataError("WORKER_IMAGE_PROFILE_JSON"))
}
fn purpose(value: &Value, expected: &str) -> Result<()> {
    need(
        matches!(&field(value,"version")?.0,Node::Number(Number::Integer(v)) if v=="1")
            && scalar(field(value, "purpose")?)? == expected,
        "WORKER_IMAGE_PROFILE_PURPOSE",
    )
}
fn code(value: &Value) -> Result<CodeFile> {
    closed(value, &["path", "sha256", "bytes"])?;
    let bytes = unsigned(field(value, "bytes")?)?
        .to_u64()
        .filter(|v| *v > 0)
        .ok_or(ResourceActorDataError("WORKER_IMAGE_PROFILE_BYTES"))?;
    let path = text(field(value, "path")?)?;
    let scalar = path
        .codepoints()
        .iter()
        .copied()
        .map(char::from_u32)
        .collect::<Option<String>>()
        .ok_or(ResourceActorDataError("WORKER_IMAGE_PROFILE_PATH"))?;
    need(
        scalar.starts_with("/nix/store/")
            && !scalar.split('/').any(|p| matches!(p, "." | ".."))
            && !scalar.contains('\0'),
        "WORKER_IMAGE_PROFILE_PATH",
    )?;
    Ok(CodeFile {
        path,
        sha256: digest(field(value, "sha256")?)?,
        bytes,
    })
}
fn program(value: &Value, factory: &Value) -> Result<()> {
    purpose(value, "worker-child-program-v1")?;
    let system = scalar(field(factory, "system")?)?;
    need(
        scalar(field(value, "abi")?)? == "record-pane-exit-v1"
            && unsigned(field(value, "elfMachine")?)?.to_u64()
                == Some(if system == "x86_64-linux" { 62 } else { 183 }),
        "WORKER_IMAGE_CHILD_ABI",
    )?;
    need(
        code(field(value, "program")?)?.bytes <= 256 * 1024 * 1024,
        "WORKER_IMAGE_CHILD_BOUND",
    )
}
#[cfg(test)]
mod tests;
