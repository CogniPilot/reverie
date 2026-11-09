//! Measured package image DATA. Decoding does not qualify a source, immutable
//! input, native engine, OS installation or permission to create a controller.
use super::*;
mod image;
use image::ImageInput;

pub const POOL_IMAGE_INPUTS_PURPOSE: &str = "worker-pool-image-inputs-v1";
pub const POOL_IMAGE_INPUT_FACTORY_FILES: [&str; 7] = [
    "nix/worker-pool-anchor-image.nix",
    "nix/worker-resource-controller-image.nix",
    "nix/worker-resource-controller.nix",
    "nix/native-worker-packages.nix",
    "nix/rust-workspace-source.nix",
    "nix/source-filter.nix",
    "Cargo.lock",
];
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PoolImageRole {
    Controller,
    Anchor,
}
impl PoolImageRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Controller => "controller",
            Self::Anchor => "anchor",
        }
    }
}
enum System {
    X86,
    Arm,
}
impl System {
    fn decode(value: &Value) -> Result<Self> {
        match scalar(value)?.as_str() {
            "x86_64-linux" => Ok(Self::X86),
            "aarch64-linux" => Ok(Self::Arm),
            _ => Err(ResourceActorDataError("POOL_IMAGE_INPUTS_SYSTEM")),
        }
    }
    fn name(&self) -> &'static str {
        match self {
            Self::X86 => "x86_64-linux",
            Self::Arm => "aarch64-linux",
        }
    }
    fn architecture(&self) -> &'static str {
        match self {
            Self::X86 => "amd64",
            Self::Arm => "arm64",
        }
    }
}
struct FilePin {
    digest: JournalDigest,
    bytes: u64,
}
pub struct PoolImageInputsData {
    system: System,
    source: PythonText,
    files: BTreeMap<&'static str, FilePin>,
    controller: ImageInput,
    anchor: ImageInput,
}
impl PoolImageInputsData {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        need(
            !raw.is_empty() && raw.len() <= 65536,
            "POOL_IMAGE_INPUTS_BOUND",
        )?;
        let value = legacy_json::decode_strict_bytes(raw)
            .map_err(|_| ResourceActorDataError("POOL_IMAGE_INPUTS_JSON"))?;
        closed(
            &value,
            &[
                "version",
                "purpose",
                "system",
                "source",
                "controller",
                "anchor",
            ],
        )?;
        need(
            matches!(&field(&value,"version")?.0,Node::Number(Number::Integer(v)) if v=="1")
                && scalar(field(&value, "purpose")?)? == POOL_IMAGE_INPUTS_PURPOSE,
            "POOL_IMAGE_INPUTS_PURPOSE",
        )?;
        let system = System::decode(field(&value, "system")?)?;
        let source = field(&value, "source")?;
        closed(source, &["path", "files"])?;
        let files = source_files(field(source, "files")?)?;
        Ok(Self {
            source: absolute(field(source, "path")?)?,
            controller: ImageInput::decode(field(&value, "controller")?, &system)?,
            anchor: ImageInput::decode(field(&value, "anchor")?, &system)?,
            system,
            files,
        })
    }
    pub fn system(&self) -> &'static str {
        self.system.name()
    }
    pub fn source_root(&self) -> &PythonText {
        &self.source
    }
    pub fn factory_files(&self) -> impl Iterator<Item = (&'static str, &JournalDigest, u64)> {
        self.files
            .iter()
            .map(|(name, pin)| (*name, &pin.digest, pin.bytes))
    }
    fn selected(&self, role: PoolImageRole) -> &ImageInput {
        match role {
            PoolImageRole::Controller => &self.controller,
            PoolImageRole::Anchor => &self.anchor,
        }
    }
    pub fn archive(&self, role: PoolImageRole) -> &CodeFile {
        &self.selected(role).archive
    }
    pub fn archive_config_digest(&self, role: PoolImageRole) -> &JournalDigest {
        &self.selected(role).config
    }
}
fn source_files(value: &Value) -> Result<BTreeMap<&'static str, FilePin>> {
    closed(value, &POOL_IMAGE_INPUT_FACTORY_FILES)?;
    POOL_IMAGE_INPUT_FACTORY_FILES
        .iter()
        .map(|&name| {
            let pin = field(value, name)?;
            closed(pin, &["sha256", "bytes"])?;
            Ok((
                name,
                FilePin {
                    digest: digest(field(pin, "sha256")?)?,
                    bytes: positive(field(pin, "bytes")?)?,
                },
            ))
        })
        .collect()
}
fn positive(value: &Value) -> Result<u64> {
    unsigned(value)?
        .to_u64()
        .filter(|value| *value > 0)
        .ok_or(ResourceActorDataError("POOL_IMAGE_INPUTS_BYTES"))
}
fn absolute(value: &Value) -> Result<PythonText> {
    let raw = scalar(value)?;
    need(
        raw.len() > 1
            && raw.starts_with('/')
            && !raw.contains('\0')
            && raw
                .split('/')
                .skip(1)
                .all(|part| !matches!(part, "" | "." | "..")),
        "POOL_IMAGE_INPUTS_PATH",
    )?;
    text(value)
}
impl EngineMetadata {
    /// Compare already observed image DATA through the SAME full-field and
    /// descriptor/config identity codec used by existing image consumers.
    pub fn qualify_pool_image(
        &self,
        inputs: &PoolImageInputsData,
        role: PoolImageRole,
    ) -> Result<String> {
        let selected = inputs.selected(role);
        self.qualify_image_fields(&selected.config, &selected.image)
    }
}
