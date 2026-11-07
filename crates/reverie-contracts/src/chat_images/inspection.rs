//! Original full-inspect projection is DATA, never a running-laptop permit.
use super::*;
use crate::{storage_identity::MetadataText, worker_config::encode_data};
use reverie_core::{
    decimal::UnsignedInteger,
    ids::{ContainerId, ProfileSessionId},
    worker_laptop::WorkerContainerName,
    worker_schema::WorkerIds,
};

pub struct ImageMount(Value);
impl ImageMount {
    pub fn kind_is(&self, kind: &str) -> bool {
        matches!(field(self.fields(),"Type"),Some(Value(Node::String(value)))if value.equals_ascii(kind))
    }
    fn fields(&self) -> &BTreeMap<Text, Value> {
        object(&self.0, "isolation_unverified").expect("mount object")
    }
    fn string(&self, name: &str) -> Option<MetadataText> {
        match field(self.fields(), name) {
            Some(Value(Node::String(text))) => Some(MetadataText::from_text(text.clone())),
            _ => None,
        }
    }
    pub fn source(&self) -> Option<MetadataText> {
        self.string("Source")
    }
    pub fn destination(&self) -> Option<MetadataText> {
        self.string("Destination")
    }
    pub fn read_write_is(&self, expected: bool) -> bool {
        matches!(field(self.fields(),"RW"),Some(Value(Node::Bool(value)))if *value == expected)
    }
}
pub struct ImageInspection {
    container: ContainerId,
    pid: UnsignedInteger,
    image: Value,
    started: Value,
    mounts: Vec<ImageMount>,
}
pub struct ImageStorageProjection<'a> {
    pub session: &'a ProfileSessionId,
    pub employee: &'a str,
    pub owner: &'a Option<MetadataText>,
    pub root: &'a MetadataText,
}
pub struct ImageNamespaceProjection<'a> {
    pub start: &'a str,
    pub generation: &'a UnsignedInteger,
    pub temporary: [u64; 2],
    pub office: [u64; 2],
}
pub fn decode_inspection(
    raw: &str,
    name: &WorkerContainerName,
    deployment: &str,
    session: &ProfileSessionId,
    employee: &str,
    ids: WorkerIds,
) -> Result<ImageInspection> {
    let root = legacy_json::decode_python_str(raw.as_bytes())
        .map_err(|_| ImageDataError("laptop_unavailable"))?;
    let Node::Array(rows) = &root.0 else {
        return Err(ImageDataError("laptop_unavailable"));
    };
    need(rows.len() == 1, "laptop_unavailable")?;
    let item = object(&rows[0], "laptop_unavailable")?;
    need(
        text(field(item, "Name"), "laptop_unavailable")? == format!("/{}", name.as_str()),
        "laptop_unavailable",
    )?;
    let container = ContainerId::parse(&text(field(item, "Id"), "laptop_unavailable")?)
        .map_err(|_| ImageDataError("laptop_unavailable"))?;
    let config = object(
        field(item, "Config").ok_or(ImageDataError("laptop_unavailable"))?,
        "laptop_unavailable",
    )?;
    let labels = object(
        field(config, "Labels").ok_or(ImageDataError("laptop_unavailable"))?,
        "laptop_unavailable",
    )?;
    for (key, expected) in [
        ("reverie.worker", deployment),
        ("reverie.session", session.as_str()),
        ("reverie.employee", employee),
    ] {
        need(
            text(field(labels, key), "laptop_unavailable")? == expected,
            "laptop_unavailable",
        )?;
    }
    need(
        text(field(config, "User"), "laptop_unavailable")?
            == format!("{}:{}", ids.uid(), ids.gid()),
        "laptop_unavailable",
    )?;
    let state = object(
        field(item, "State").ok_or(ImageDataError("laptop_unavailable"))?,
        "laptop_unavailable",
    )?;
    for (key, expected) in [
        ("Running", true),
        ("Paused", false),
        ("Restarting", false),
        ("Dead", false),
    ] {
        need(
            matches!(field(state,key),Some(Value(Node::Bool(value)))if *value==expected),
            "laptop_unavailable",
        )?;
    }
    let Some(Value(Node::Number(Number::Integer(pid)))) = field(state, "Pid") else {
        return Err(ImageDataError("laptop_unavailable"));
    };
    let pid = UnsignedInteger::parse(pid)
        .filter(|value| value.as_str() != "0")
        .ok_or(ImageDataError("laptop_unavailable"))?;
    let Some(Value(Node::Array(mounts))) = field(item, "Mounts") else {
        return Err(ImageDataError("isolation_unverified"));
    };
    let mounts = mounts
        .iter()
        .map(|mount| {
            object(mount, "isolation_unverified")?;
            Ok(ImageMount(mount.deep_clone()))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(ImageInspection {
        container,
        pid,
        mounts,
        image: field(item, "Image").map_or(Value(Node::Null), Value::deep_clone),
        started: field(state, "StartedAt").map_or(Value(Node::Null), Value::deep_clone),
    })
}
fn string(value: &str) -> Value {
    Value(Node::String(key(value)))
}
fn metadata(value: &MetadataText) -> Value {
    Value(Node::String(Text(value.codepoints().to_vec())))
}
fn pair(value: [u64; 2]) -> Value {
    Value(Node::Array(
        value
            .into_iter()
            .map(|n| Value(Node::Number(Number::Integer(n.to_string()))))
            .collect(),
    ))
}
impl ImageInspection {
    pub fn pid(&self) -> &UnsignedInteger {
        &self.pid
    }
    pub fn mounts(&self) -> &[ImageMount] {
        &self.mounts
    }
    pub fn projection(
        &self,
        storage: ImageStorageProjection<'_>,
        namespace: ImageNamespaceProjection<'_>,
    ) -> ImageDigest {
        let mut mounts = self
            .mounts
            .iter()
            .map(|mount| mount.0.deep_clone())
            .collect::<Vec<_>>();
        mounts.sort_by_key(encode_data);
        let values = [
            ("session", string(storage.session.as_str())),
            ("employee", string(storage.employee)),
            (
                "owner",
                storage.owner.as_ref().map_or(Value(Node::Null), metadata),
            ),
            ("storage", metadata(storage.root)),
            ("container", string(self.container.as_str())),
            ("image", self.image.deep_clone()),
            (
                "pid",
                Value(Node::Number(Number::Integer(self.pid.as_str().to_owned()))),
            ),
            ("start", string(namespace.start)),
            ("startedAt", self.started.deep_clone()),
            (
                "generation",
                Value(Node::Number(Number::Integer(
                    namespace.generation.as_str().to_owned(),
                ))),
            ),
            ("temporary", pair(namespace.temporary)),
            ("office", pair(namespace.office)),
            ("mounts", Value(Node::Array(mounts))),
        ];
        let root = Value(Node::Object(
            values
                .into_iter()
                .map(|(name, value)| (key(name), value))
                .collect(),
        ));
        image_digest(&encode_data(&root))
    }
}
