use super::*;
pub(super) struct ImageInput {
    pub(super) archive: CodeFile,
    pub(super) config: JournalDigest,
    pub(super) image: Value,
}
impl ImageInput {
    pub(super) fn decode(value: &Value, system: &System) -> Result<Self> {
        closed(value, &["archive", "archiveConfigSHA256", "imageSpec"])?;
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
        })
    }
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
