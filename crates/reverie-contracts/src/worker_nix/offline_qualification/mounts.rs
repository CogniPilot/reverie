//! Read-only offline store views of Docker inspection data.
use super::{QualificationError, Result, require};
use crate::legacy_json::{Node, Number, Text, Value, decode_strict_bytes, numeric_key, truthy};
use reverie_core::PythonText;
use std::collections::BTreeMap;

type Object = BTreeMap<Text, Value>;
const MALFORMED: QualificationError = QualificationError("container mount inventory unavailable");
const SANDBOX: QualificationError = QualificationError("offline image check sandbox differs");

pub struct Bind {
    source: PythonText,
    writer: bool,
}
impl Bind {
    pub fn source(&self) -> &[u32] {
        self.source.codepoints()
    }
    pub fn running_writer(&self) -> bool {
        self.writer
    }
}

pub struct ImageBind {
    source: PythonText,
    destination: PythonText,
}
impl ImageBind {
    pub fn source(&self) -> &[u32] {
        self.source.codepoints()
    }
    pub fn destination(&self) -> &[u32] {
        self.destination.codepoints()
    }
}

pub fn inspected_binds(raw: &[u8]) -> Result<Vec<Bind>> {
    let data = decode_strict_bytes(raw).map_err(|_| MALFORMED)?;
    let Node::Array(rows) = &data.0 else {
        return Err(MALFORMED);
    };
    require(rows.len() <= 32, MALFORMED.0)?;
    let mut binds = Vec::new();
    for row in rows {
        let row = object(row)?;
        let state = field(row, "State").map(object).transpose()?;
        let running = truthy(state.and_then(|s| field(s, "Running")));
        for mount in mounts(row)? {
            let mount = object(mount)?;
            if text_is(field(mount, "Type"), "bind") {
                binds.push(Bind {
                    source: text(field(mount, "Source"))?,
                    writer: running && truthy(field(mount, "RW")),
                });
            }
        }
    }
    Ok(binds)
}

pub fn isolated_image_binds(raw: &[u8], uid: u32, gid: u32) -> Result<Vec<ImageBind>> {
    let data = decode_strict_bytes(raw).map_err(|_| MALFORMED)?;
    let row = object(&data)?;
    check_sandbox(row, uid, gid)?;
    let mut binds = Vec::new();
    for mount in mounts(row)? {
        let mount = object(mount)?;
        let kind = field(mount, "Type");
        if text_is(kind, "tmpfs") {
            continue;
        }
        require(
            text_is(kind, "bind")
                && (matches!(field(mount, "RW"), Some(Value(Node::Bool(false))))
                    || text_is(field(mount, "Destination"), "/output")),
            "offline image check has unexpected writable grant",
        )?;
        binds.push(ImageBind {
            source: text(field(mount, "Source"))?,
            destination: text(field(mount, "Destination"))?,
        });
    }
    Ok(binds)
}

fn check_sandbox(row: &Object, uid: u32, gid: u32) -> Result<()> {
    let config = field(row, "Config")
        .and_then(|v| object(v).ok())
        .ok_or(SANDBOX)?;
    let host = field(row, "HostConfig")
        .and_then(|v| object(v).ok())
        .ok_or(SANDBOX)?;
    require(
        text_is(field(config, "User"), &format!("{uid}:{gid}"))
            && isolated_namespaces(host)
            && isolated_resources(host),
        SANDBOX.0,
    )
}

fn isolated_namespaces(host: &Object) -> bool {
    let caps = matches!(field(host, "CapDrop"), Some(Value(Node::Array(values)))
        if matches!(values.as_slice(), [only] if text_is(Some(only), "ALL")));
    let security = matches!(field(host, "SecurityOpt"), Some(Value(Node::Array(values)))
        if values.iter().any(|value| text_is(Some(value), "no-new-privileges")
            || text_is(Some(value), "no-new-privileges:true")));
    text_is(field(host, "NetworkMode"), "none")
        && matches!(field(host, "ReadonlyRootfs"), Some(Value(Node::Bool(true))))
        && ["Privileged", "CapAdd", "VolumesFrom"]
            .iter()
            .all(|key| !truthy(field(host, key)))
        && [("PidMode", ""), ("IpcMode", "private"), ("UsernsMode", "")]
            .iter()
            .all(|(key, default)| field(host, key).is_none_or(|v| text_is(Some(v), default)))
        && caps
        && security
}

fn isolated_resources(host: &Object) -> bool {
    let memory = field(host, "Memory");
    positive_integer(memory, 4 * 1024 * 1024 * 1024)
        && memory.and_then(|v| numeric_key(&v.0))
            == field(host, "MemorySwap").and_then(|v| numeric_key(&v.0))
        && positive_integer(field(host, "PidsLimit"), 256)
        && positive_integer(field(host, "NanoCpus"), 2_000_000_000)
}

fn positive_integer(value: Option<&Value>, limit: u64) -> bool {
    matches!(value, Some(Value(Node::Number(Number::Integer(v))))
        if v.parse::<u64>().is_ok_and(|number| (1..=limit).contains(&number)))
}

fn mounts(row: &Object) -> Result<&[Value]> {
    match field(row, "Mounts") {
        Some(Value(Node::Array(items))) => Ok(items),
        None => Ok(&[]),
        _ => Err(MALFORMED),
    }
}

fn object(value: &Value) -> Result<&Object> {
    if let Node::Object(fields) = &value.0 {
        Ok(fields)
    } else {
        Err(MALFORMED)
    }
}

fn field<'a>(object: &'a Object, name: &str) -> Option<&'a Value> {
    object.get(&Text(name.bytes().map(u32::from).collect()))
}

fn text_is(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value(Node::String(text))) if text.equals_ascii(expected))
}

fn text(value: Option<&Value>) -> Result<PythonText> {
    let Some(Value(Node::String(value))) = value else {
        return Err(MALFORMED);
    };
    PythonText::try_new(value.0.clone()).map_err(|_| MALFORMED)
}
