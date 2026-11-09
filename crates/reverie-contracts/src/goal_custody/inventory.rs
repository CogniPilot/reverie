//! Original Goal inventory data checks. Native namespace/canonical filesystem
//! observations and the actual accepted peer remain mandatory host work.
use super::configuration::{absolute, scalar};
use super::*;
use reverie_core::ids::ContainerId;
use reverie_core::posix_path::PosixPath;
use std::collections::BTreeSet;

pub struct GoalMount {
    kind: String,
    source: Option<Value>,
    destination: Option<Value>,
}
impl GoalMount {
    pub fn is_bind(&self) -> bool {
        self.kind == "bind"
    }
    pub fn source(&self) -> Result<PosixPath> {
        absolute(self.source.as_ref().ok_or(GoalDataError::Inventory)?)
    }
    pub fn destination(&self) -> Result<PosixPath> {
        absolute(self.destination.as_ref().ok_or(GoalDataError::Inventory)?)
    }
}
pub struct GoalInventory {
    server_pid: u32,
    server_mounts: Vec<GoalMount>,
    exposed: Vec<PosixPath>,
}
impl GoalInventory {
    pub fn decode(
        raw: &[u8],
        ids: &[ContainerId],
        config: &GoalPrivateConfig,
        server_name: &str,
        uid: u32,
        gid: u32,
    ) -> Result<Self> {
        let value = legacy_json::decode_engine_inventory(raw).map_err(|_| GoalDataError::Json)?;
        let Node::Array(rows) = &value.0 else {
            return Err(GoalDataError::Inventory);
        };
        if rows.len() != ids.len() {
            return Err(GoalDataError::Inventory);
        }
        let mut found = BTreeSet::new();
        for row in rows {
            let fields = object(row)?;
            let id = ContainerId::parse(&scalar(field(fields, "Id")?)?)
                .map_err(|_| GoalDataError::Inventory)?;
            if !ids.contains(&id) {
                return Err(GoalDataError::Inventory);
            }
            found.insert(id);
        }
        if found.len() != ids.len() {
            return Err(GoalDataError::Inventory);
        }
        // Preserve source ordering: every runtime-injection check precedes
        // selecting the pinned server or inspecting any private path.
        for row in rows {
            runtime_injection(object(row)?)?;
        }
        let server = rows
            .iter()
            .find(|row| {
                object(row)
                    .ok()
                    .and_then(|f| f.get(&key("Id")))
                    .is_some_and(|v| {
                        scalar(v).ok().as_deref() == Some(config.server_container().as_str())
                    })
            })
            .ok_or(GoalDataError::Inventory)?;
        let fields = object(server)?;
        if scalar(field(fields, "Name")?)? != format!("/{server_name}") {
            return Err(GoalDataError::Inventory);
        }
        let state = object(field(fields, "State")?)?;
        if !matches!(field(state, "Running")?, Value(Node::Bool(true))) {
            return Err(GoalDataError::Inventory);
        }
        let server_pid = configuration::integer(field(state, "Pid")?)?;
        if server_pid == 0 {
            return Err(GoalDataError::Inventory);
        }
        let settings = object(field(fields, "Config")?)?;
        if scalar(field(settings, "User")?)? != format!("{uid}:{gid}") {
            return Err(GoalDataError::Inventory);
        }
        let mut exposed = Vec::new();
        let mut server_mounts = None;
        for row in rows {
            let fields = object(row)?;
            let is_server = scalar(field(fields, "Id")?)? == config.server_container().as_str();
            let mounts = mounts(field(fields, "Mounts")?)?;
            if is_server {
                server_mounts = Some(mounts);
            } else {
                exposed.extend(exposed_mounts(&mounts)?);
            }
        }
        Ok(Self {
            server_pid,
            server_mounts: server_mounts.expect("pinned server in checked complete inventory"),
            exposed,
        })
    }
    pub fn server_pid(&self) -> u32 {
        self.server_pid
    }
    pub fn server_mounts(&self) -> &[GoalMount] {
        &self.server_mounts
    }
    pub fn exposed_roots(&self) -> &[PosixPath] {
        &self.exposed
    }
}
fn exposed_mounts(mounts: &[GoalMount]) -> Result<Vec<PosixPath>> {
    mounts
        .iter()
        .filter(|mount| mount.kind != "tmpfs")
        .map(GoalMount::source)
        .collect()
}
pub fn inventory_identifiers(raw: &[u8]) -> Result<Vec<ContainerId>> {
    let value = std::str::from_utf8(raw).map_err(|_| GoalDataError::Inventory)?;
    let normalized = value.replace("\r\n", "\n");
    let mut pieces: Vec<_> = normalized
        .split([
            '\n', '\r', '\u{000b}', '\u{000c}', '\u{001c}', '\u{001d}', '\u{001e}', '\u{0085}',
            '\u{2028}', '\u{2029}',
        ])
        .collect();
    if pieces.last() == Some(&"") {
        pieces.pop();
    }
    if !(1..=64).contains(&pieces.len()) {
        return Err(GoalDataError::Inventory);
    }
    let ids = pieces
        .into_iter()
        .map(|value| ContainerId::parse(value).map_err(|_| GoalDataError::Inventory))
        .collect::<Result<Vec<_>>>()?;
    if ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
        return Err(GoalDataError::Inventory);
    }
    Ok(ids)
}
fn mounts(value: &Value) -> Result<Vec<GoalMount>> {
    let Node::Array(rows) = &value.0 else {
        return Err(GoalDataError::Inventory);
    };
    rows.iter()
        .map(|row| {
            let fields = object(row)?;
            let kind = scalar(field(fields, "Type")?)?;
            if !["bind", "volume", "tmpfs"].contains(&kind.as_str()) {
                return Err(GoalDataError::Inventory);
            }
            Ok(GoalMount {
                kind,
                source: fields.get(&key("Source")).map(Value::deep_clone),
                destination: fields.get(&key("Destination")).map(Value::deep_clone),
            })
        })
        .collect()
}
fn runtime_injection(row: &Object) -> Result<()> {
    let host = object(field(row, "HostConfig")?)?;
    let runtime = scalar(field(host, "Runtime")?)?;
    if !["runc", "io.containerd.runc.v2"].contains(&runtime.as_str())
        || !matches!(field(host, "Privileged")?, Value(Node::Bool(false)))
    {
        return Err(GoalDataError::Inventory);
    }
    for name in [
        "Devices",
        "DeviceRequests",
        "DeviceCgroupRules",
        "CDIDevices",
        "CdiDevices",
        "CapAdd",
        "VolumesFrom",
    ] {
        if !none_or_empty(host.get(&key(name)), false) {
            return Err(GoalDataError::Inventory);
        }
    }
    if !none_or_empty(host.get(&key("Annotations")), true)
        || !none_or_empty(row.get(&key("Annotations")), true)
    {
        return Err(GoalDataError::Inventory);
    }
    if let Some(config) = row.get(&key("Config"))
        && !none_or_empty(object(config)?.get(&key("Annotations")), true)
    {
        return Err(GoalDataError::Inventory);
    }
    for (name, allowed) in [
        ("PidMode", &[""][..]),
        ("IpcMode", &["", "private", "shareable"][..]),
        ("UsernsMode", &[""][..]),
    ] {
        if let Some(value) = host.get(&key(name))
            && !matches!(value, Value(Node::Null))
            && !allowed.contains(&scalar(value)?.as_str())
        {
            return Err(GoalDataError::Inventory);
        }
    }
    let security = host.get(&key("SecurityOpt"));
    if none_or_empty(security, false) {
        return Ok(());
    }
    let Some(Value(Node::Array(values))) = security else {
        return Err(GoalDataError::Inventory);
    };
    if values.len() != 1
        || !["no-new-privileges", "no-new-privileges:true"].contains(&scalar(&values[0])?.as_str())
    {
        return Err(GoalDataError::Inventory);
    }
    Ok(())
}
fn none_or_empty(value: Option<&Value>, object: bool) -> bool {
    match value {
        None | Some(Value(Node::Null)) => true,
        Some(Value(Node::Object(values))) if object => values.is_empty(),
        Some(Value(Node::Array(values))) if !object => values.is_empty(),
        _ => false,
    }
}
