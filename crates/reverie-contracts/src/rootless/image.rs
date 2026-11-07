use super::*;
use crate::legacy_json;
use reverie_core::rootless::{SubordinateRange, granted};

/// Captured image inspection data, never an observation of the selected engine.
pub struct RootlessImage(Value);
impl RootlessImage {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        let value = legacy_json::decode_rootless_profile(raw).map_err(|_| RootlessError::Json)?;
        Ok(Self(value))
    }
    /// The original broker's singleton image-inspection envelope and exact
    /// selected image check. This is DATA, not current engine/image authority.
    pub fn decode_inspection(raw: &[u8], expected: &MetadataText) -> Result<Self> {
        let mut value =
            legacy_json::decode_engine_inventory(raw).map_err(|_| RootlessError::Json)?;
        let Node::Array(rows) = &mut value.0 else {
            return Err(RootlessError::Image);
        };
        if rows.len() != 1 {
            return Err(RootlessError::Image);
        }
        let row = rows.pop().expect("checked singleton image");
        let fields = object(&row).map_err(|_| RootlessError::Image)?;
        if !matches!(field(fields, "Id"), Some(Value(Node::String(actual))) if actual.0 == expected.codepoints())
        {
            return Err(RootlessError::Image);
        }
        Ok(Self(row))
    }
}
pub struct ImageMappings {
    uid: ImageInteger,
    gid: ImageInteger,
    count: ImageInteger,
}
/// Matching image labels are only captured data, not native engine identity.
pub struct RootlessImageIdentity<'a> {
    labels: &'a Object,
}
impl RootlessImageIdentity<'_> {
    pub fn mappings(&self) -> Result<ImageMappings> {
        Ok(ImageMappings {
            uid: integers::integer(field(self.labels, "org.reverie.worker.subuid-start"))?,
            gid: integers::integer(field(self.labels, "org.reverie.worker.subgid-start"))?,
            count: integers::integer(field(self.labels, "org.reverie.worker.subid-count"))?,
        })
    }
}
impl ImageMappings {
    pub fn uid_start(&self) -> &ImageInteger {
        &self.uid
    }
    pub fn gid_start(&self) -> &ImageInteger {
        &self.gid
    }
    pub fn count(&self) -> &ImageInteger {
        &self.count
    }
    pub fn granted(&self, uids: &[SubordinateRange], gids: &[SubordinateRange]) -> bool {
        self.uid_granted(uids) && self.gid_granted(gids)
    }
    pub fn count_sufficient(&self) -> bool {
        self.count
            .nonnegative()
            .is_some_and(reverie_core::rootless::count_sufficient)
    }
    pub fn uid_granted(&self, ranges: &[SubordinateRange]) -> bool {
        self.contains(ranges, &self.uid)
    }
    pub fn gid_granted(&self, ranges: &[SubordinateRange]) -> bool {
        self.contains(ranges, &self.gid)
    }
    fn contains(&self, ranges: &[SubordinateRange], start: &ImageInteger) -> bool {
        match (start.nonnegative(), self.count.nonnegative()) {
            (Some(start), Some(count)) => granted(ranges, start, count),
            _ => false,
        }
    }
}
impl RootlessConfig {
    pub fn image_mappings(&self, image: &RootlessImage) -> Result<Option<ImageMappings>> {
        self.image_identity(image)?
            .map(|identity| identity.mappings())
            .transpose()
    }
    pub fn image_identity<'a>(
        &self,
        image: &'a RootlessImage,
    ) -> Result<Option<RootlessImageIdentity<'a>>> {
        let Some(option) = &self.option else {
            return Ok(None);
        };
        let root = object(&image.0).map_err(|_| RootlessError::Image)?;
        let selected = object(field(root, "Config").ok_or(RootlessError::Image)?)
            .map_err(|_| RootlessError::Image)?;
        let labels = match field(selected, "Labels") {
            value if !legacy_json::truthy(value) => return Err(RootlessError::Image),
            Some(value) => object(value).map_err(|_| RootlessError::Image)?,
            None => return Err(RootlessError::Image),
        };
        let expected = format!("{}:{}", option.ids.uid(), option.ids.gid());
        if !matches!(field(selected,"User"),Some(Value(Node::String(value))) if value.0.iter().copied().eq(expected.chars().map(u32::from)))
        {
            return Err(RootlessError::Image);
        }
        for (name, expected) in [
            ("org.reverie.worker.rootless-docker", "1".into()),
            ("org.reverie.worker.uid", option.ids.uid().to_string()),
            ("org.reverie.worker.gid", option.ids.gid().to_string()),
            (
                "org.reverie.worker.rootless-docker.mount-layout",
                "1".into(),
            ),
        ] {
            if !matches!(field(labels,name), Some(Value(Node::String(value))) if value.equals_ascii(&expected))
            {
                return Err(RootlessError::Image);
            }
        }
        Ok(Some(RootlessImageIdentity { labels }))
    }
}
/// Decodes the fixed host grant file's UTF-8 text and Python splitlines/isdigit
/// semantics. Names are captured pwd data, not caller-selected file paths.
pub fn parse_host_grants(raw: &[u8], name: &[u32], uid: u32) -> Result<Vec<SubordinateRange>> {
    if raw.len() > MAX_SUBID_BYTES {
        return Err(RootlessError::SubIds);
    }
    let value = std::str::from_utf8(raw).map_err(|_| RootlessError::SubIds)?;
    let uid = uid.to_string();
    let mut ranges = Vec::new();
    for line in value.split(|c| {
        matches!(
            c,
            '\n' | '\r'
                | '\u{b}'
                | '\u{c}'
                | '\u{1c}'
                | '\u{1d}'
                | '\u{1e}'
                | '\u{85}'
                | '\u{2028}'
                | '\u{2029}'
        )
    }) {
        let fields = line.split(':').collect::<Vec<_>>();
        if fields.len() != 3
            || !(name.iter().copied().eq(fields[0].chars().map(u32::from)) || fields[0] == uid)
        {
            continue;
        }
        let low = fields[1].chars().map(u32::from).collect::<Vec<_>>();
        let count = fields[2].chars().map(u32::from).collect::<Vec<_>>();
        if !low.is_empty()
            && !count.is_empty()
            && low
                .iter()
                .chain(&count)
                .all(|&point| integers::is_digit(point))
        {
            ranges.push(SubordinateRange::new(
                integers::string_integer(&low)?
                    .nonnegative()
                    .ok_or(RootlessError::SubIds)?
                    .clone(),
                integers::string_integer(&count)?
                    .nonnegative()
                    .ok_or(RootlessError::SubIds)?
                    .clone(),
            ));
        }
    }
    Ok(ranges)
}
