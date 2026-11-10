use super::*;
use sha2::{Digest, Sha256};

pub struct WebsiteArchiveManifest {
    config: String,
    layers: Vec<PythonText>,
}
impl WebsiteArchiveManifest {
    /// The native build reader must supply the complete regular-member census
    /// after canonical-name, duplicate, member-count and stream-bound checks.
    pub fn decode(raw: &[u8], regular: &[PythonText]) -> Result<Self> {
        let value = decode(raw, 4 << 20)?;
        let items = array(&value)?;
        need(items.len() == 1, "WEBSITE_BUILD_EXACTLY_ONE_IMAGE")?;
        let item = &items[0];
        closed(item, &["Config", "RepoTags", "Layers"])?;
        let config = scalar(field(item, "Config")?)?;
        need(
            config
                .strip_suffix(".json")
                .is_some_and(|name| JournalDigest::parse(name).is_ok())
                && regular.contains(&PythonText::from_scalar_text(&config)),
            "WEBSITE_BUILD_CONFIGURATION_MEMBER",
        )?;
        let layers = array(field(item, "Layers")?)?
            .iter()
            .map(text)
            .collect::<Result<Vec<_>>>()?;
        need(
            (1..=256).contains(&layers.len()) && layers.iter().all(|name| regular.contains(name)),
            "WEBSITE_BUILD_COMPLETE_IMAGE_LAYERS",
        )?;
        Ok(Self { config, layers })
    }
    pub fn config_member(&self) -> &str {
        &self.config
    }
    pub fn layer_members(&self) -> &[PythonText] {
        &self.layers
    }
}
pub struct WebsiteArchiveConfiguration {
    pub(super) digest: JournalDigest,
    pub(super) image: Value,
}
impl WebsiteArchiveConfiguration {
    /// Qualifies archive metadata, not actual layer bytes, privacy, daemon
    /// identity, ownership, native file custody or installed service state.
    pub fn decode(raw: &[u8], selected: &WebsiteArchiveManifest) -> Result<Self> {
        let digest = format!("{:x}", Sha256::digest(raw));
        need(
            selected.config == format!("{digest}.json"),
            "WEBSITE_BUILD_CONFIG_IDENTITY",
        )?;
        let document = decode(raw, 4 << 20)?;
        let config = field(&document, "config")?;
        object(config)?;
        let rootfs = field(&document, "rootfs")?;
        closed(rootfs, &["type", "diff_ids"])?;
        let layers = array(field(rootfs, "diff_ids")?)?;
        need(
            scalar(field(rootfs, "type")?)? == "layers" && layers.len() == selected.layers.len(),
            "WEBSITE_BUILD_COMPLETE_ROOTFS",
        )?;
        for value in layers {
            let value = scalar(value)?;
            need(
                value
                    .strip_prefix("sha256:")
                    .is_some_and(|v| JournalDigest::parse(v).is_ok()),
                "WEBSITE_BUILD_DIFF_ID",
            )?;
        }
        let architecture = scalar(field(&document, "architecture")?)?;
        need(
            (1..=32).contains(&architecture.len())
                && architecture
                    .bytes()
                    .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit() || v == b'_')
                && scalar(field(&document, "os")?)? == "linux",
            "WEBSITE_BUILD_IMAGE_PLATFORM",
        )?;
        let created = field(&document, "created")?;
        need(
            image_time::instant(text(created)?.codepoints()).is_some(),
            "WEBSITE_BUILD_CREATION_TIMEZONE",
        )?;
        Ok(Self {
            digest: JournalDigest::parse(&digest).expect("SHA256"),
            image: fields([
                ("Config", config.deep_clone()),
                (
                    "RootFS",
                    fields([
                        ("Type", string("layers")),
                        ("Layers", field(rootfs, "diff_ids")?.deep_clone()),
                    ]),
                ),
                ("Architecture", string(&architecture)),
                ("Os", string("linux")),
                ("Created", created.deep_clone()),
            ]),
        })
    }
}
