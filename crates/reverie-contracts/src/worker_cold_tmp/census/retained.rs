//! Fixed original confirm_retained_temporary inspection DATA. This validates
//! neither process/mount custody nor the actual Host creation record.
use super::*;
mod init;
mod perf;
use reverie_core::{decimal::UnsignedInteger, ids::ProfileSessionId};
pub struct RetainedInspection {
    inventory: ColdInventory,
    image: MetadataText,
    pid: UnsignedInteger,
}
impl RetainedInspection {
    pub fn decode(
        raw: &[u8],
        cid: &ContainerId,
        source: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
        employee: Option<&str>,
    ) -> Result<Self> {
        Self::decode_with_init(
            raw,
            cid,
            source,
            session,
            employee,
            crate::worker_launch::WorkerInitData::LegacySleep,
        )
    }
    /// The actual created plan supplies its already projected boot-layout DATA.
    /// The legacy decoder remains fixed to its original sleep/tini contract.
    pub fn decode_started(
        raw: &[u8],
        cid: &ContainerId,
        source: &EffectiveWorkerConfig,
        effective: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
        employee: Option<&str>,
    ) -> Result<Self> {
        let init = crate::worker_launch::WorkerInitData::for_effective(effective)
            .map_err(|_| ColdDataError::Policy)?;
        Self::decode_with_init(raw, cid, source, session, employee, init)
    }
    fn decode_with_init(
        raw: &[u8],
        cid: &ContainerId,
        source: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
        employee: Option<&str>,
        init: crate::worker_launch::WorkerInitData,
    ) -> Result<Self> {
        let expected = ColdInventoryIds::decode(cid.as_str().as_bytes())?;
        let inventory = ColdInventory::decode(raw, &expected)?;
        let row = &inventory.rows[0];
        let fields = row.fields();
        let config = object(field(fields, "Config").ok_or(ColdDataError::Inventory)?)
            .ok_or(ColdDataError::Inventory)?;
        let original = object(source.as_value()).ok_or(ColdDataError::Policy)?;
        let deployment = metadata(field(original, "deployment"), ColdDataError::Policy)?;
        let deployment = deployment.scalar_text().ok_or(ColdDataError::Policy)?;
        let name = format!("/{deployment}-agent-{session}");
        let image = metadata(field(original, "image"), ColdDataError::Policy)?;
        if !row.named(&name) || metadata(field(fields, "Image"), ColdDataError::Inventory)? != image
        {
            return Err(ColdDataError::Inventory);
        }
        labels(config, &deployment, session, employee)?;
        init::configuration(fields, original, config, init)?;
        // Original confirmation checks only the native identity/state header
        // here. Mount grammar belongs AFTER actual PID/fresh-inode reads.
        let state = row.state_fields()?;
        if !state.running || state.paused || state.restarting {
            return Err(ColdDataError::State);
        }
        let pid = UnsignedInteger::parse(state.pid_text())
            .filter(|pid| !pid.is_zero())
            .ok_or(ColdDataError::State)?;
        Ok(Self {
            inventory,
            image,
            pid,
        })
    }
    pub fn row(&self) -> &ColdContainer {
        &self.inventory.rows[0]
    }
    pub fn image(&self) -> &MetadataText {
        &self.image
    }
    pub fn pid(&self) -> &UnsignedInteger {
        &self.pid
    }
    pub fn same_observation(&self, other: &Self) -> Result<bool> {
        Ok(projection(self.row())?.python_eq(&projection(other.row())?))
    }
    pub fn require_tmp_bind(&self, target: &MetadataText) -> Result<()> {
        let mut selected = Vec::new();
        for row in self.row().mount_values()? {
            let fields = object(row).ok_or(ColdDataError::Mounts)?;
            if matches!(field(fields,"Destination"),Some(Value(Node::String(value))) if value.equals_ascii("/tmp"))
            {
                selected.push(fields);
            }
        }
        if selected.len() != 1 {
            return Err(ColdDataError::Mounts);
        }
        let row = selected[0];
        if !matches!(field(row,"Type"),Some(Value(Node::String(value))) if value.equals_ascii("bind"))
            || metadata(field(row, "Source"), ColdDataError::Mounts)? != *target
            || !matches!(field(row, "RW"), Some(Value(Node::Bool(true))))
        {
            return Err(ColdDataError::Mounts);
        }
        Ok(())
    }
}
fn account<'a>(fields: &'a Object, name: &str) -> Result<&'a str> {
    match field(fields, name) {
        Some(Value(Node::Number(Number::Integer(value)))) => Ok(value),
        _ => Err(ColdDataError::Policy),
    }
}
fn labels(
    config: &Object,
    deployment: &str,
    session: &ProfileSessionId,
    employee: Option<&str>,
) -> Result<()> {
    let labels = field(config, "Labels")
        .and_then(object)
        .ok_or(ColdDataError::Inventory)?;
    let mut wanted = vec![
        ("reverie.worker", deployment),
        ("reverie.session", session.as_str()),
    ];
    if let Some(employee) = employee {
        wanted.push(("reverie.employee", employee));
    }
    for (name, expected) in wanted {
        if !matches!(field(labels,name),Some(Value(Node::String(value))) if value.equals_ascii(expected))
        {
            return Err(ColdDataError::Inventory);
        }
    }
    Ok(())
}
fn projection(row: &ColdContainer) -> Result<Value> {
    let fields = row.fields();
    let state = field(fields, "State")
        .and_then(object)
        .ok_or(ColdDataError::State)?;
    let config = field(fields, "Config")
        .and_then(object)
        .ok_or(ColdDataError::Inventory)?;
    let select =
        |fields: &Object, name| field(fields, name).map_or(Value(Node::Null), Value::deep_clone);
    let mounts = canonical_mount_rows(row.mount_values()?);
    Ok(Value(Node::Object(BTreeMap::from([
        (key("id"), select(fields, "Id")),
        (key("image"), select(fields, "Image")),
        (key("name"), select(fields, "Name")),
        (
            key("state"),
            Value(Node::Object(
                ["Running", "Paused", "Restarting", "Pid", "StartedAt"]
                    .map(|name| (key(name), select(state, name)))
                    .into(),
            )),
        ),
        (key("mounts"), Value(Node::Array(mounts))),
        (key("labels"), select(config, "Labels")),
        (key("user"), select(config, "User")),
    ]))))
}
