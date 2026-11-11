use super::*;
pub(super) struct ImageInput {
    pub(super) archive: CodeFile,
    pub(super) config: JournalDigest,
    pub(super) image: Value,
    pub(super) program: Option<CodeFile>,
}
impl ImageInput {
    pub(super) fn decode(value: &Value, system: &System, program_bound: bool) -> Result<Self> {
        if program_bound {
            closed(
                value,
                &["archive", "archiveConfigSHA256", "imageSpec", "program"],
            )?;
        } else {
            closed(value, &["archive", "archiveConfigSHA256", "imageSpec"])?;
        }
        let archive = field(value, "archive")?;
        closed(archive, &["path", "sha256", "bytes"])?;
        let image = field(value, "imageSpec")?;
        validate_image(image, system)?;
        Ok(Self {
            archive: CodeFile {
                path: absolute(field(archive, "path")?)?,
                sha256: digest(field(archive, "sha256")?)?,
                bytes: positive(field(archive, "bytes")?)?,
            },
            config: digest(field(value, "archiveConfigSHA256")?)?,
            image: image.deep_clone(),
            program: program_bound
                .then(|| program(field(value, "program")?))
                .transpose()?,
        })
    }
}
fn program(value: &Value) -> Result<CodeFile> {
    closed(value, &["path", "sha256", "bytes"])?;
    let path = absolute(field(value, "path")?)?;
    let name = scalar(field(value, "path")?)?;
    let bytes = positive(field(value, "bytes")?)?;
    need(
        name.starts_with("/nix/store/")
            && name.ends_with("/bin/reverie-worker-resource-controller")
            && bytes <= 64 * 1024 * 1024,
        "POOL_IMAGE_INPUTS_PROGRAM",
    )?;
    Ok(CodeFile {
        path,
        sha256: digest(field(value, "sha256")?)?,
        bytes,
    })
}
fn validate_image(value: &Value, system: &System) -> Result<()> {
    closed(
        value,
        &["Config", "RootFS", "Architecture", "Os", "Created"],
    )?;
    object(field(value, "Config")?)?;
    need(
        scalar(field(value, "Architecture")?)? == system.architecture()
            && scalar(field(value, "Os")?)? == "linux"
            && image_time::instant(text(field(value, "Created")?)?.codepoints()).is_some(),
        "POOL_IMAGE_INPUTS_IMAGE_SPEC",
    )?;
    let root = field(value, "RootFS")?;
    closed(root, &["Type", "Layers"])?;
    need(
        scalar(field(root, "Type")?)? == "layers",
        "POOL_IMAGE_INPUTS_ROOTFS",
    )?;
    let layers = array(field(root, "Layers")?)?;
    need(!layers.is_empty(), "POOL_IMAGE_INPUTS_ROOTFS")?;
    for layer in layers {
        let raw = scalar(layer)?;
        let hash = raw
            .strip_prefix("sha256:")
            .ok_or(ResourceActorDataError("POOL_IMAGE_INPUTS_LAYER"))?;
        JournalDigest::parse(hash)
            .map_err(|_| ResourceActorDataError("POOL_IMAGE_INPUTS_LAYER"))?;
    }
    Ok(())
}
