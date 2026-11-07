use super::*;
use crate::storage_identity::MetadataText;
use reverie_core::worker_schema::{MountTarget, RootlessMount, require_immutable_mounts};
use std::collections::BTreeSet;

/// Lexical owner declaration; source existence/resolution and attachment
/// exclusion have not been observed. Never use this value as a mount permit.
pub struct WorkerMount {
    source: MetadataText,
    destination: MountTarget,
    read_only: bool,
}
impl WorkerMount {
    pub fn source(&self) -> &MetadataText {
        &self.source
    }
    pub fn destination(&self) -> &MountTarget {
        &self.destination
    }
    pub fn read_only(&self) -> bool {
        self.read_only
    }
}
pub(super) fn declarations_observed<E: From<WorkerSchemaError>>(
    fields: &Object,
    mut observe: impl FnMut(&WorkerMount) -> std::result::Result<(), E>,
) -> std::result::Result<Vec<WorkerMount>, E> {
    let Some(Value(Node::Array(values))) = field(fields, "mounts") else {
        return Err(WorkerSchemaError::Mount.into());
    };
    if values.is_empty() {
        return Err(WorkerSchemaError::Mount.into());
    }
    let mut destinations = BTreeSet::new();
    let mut mounts = Vec::new();
    for value in values {
        let entry = object(value).ok_or(WorkerSchemaError::Mount)?;
        if entry.len() != 3
            || !["source", "destination", "readOnly"]
                .iter()
                .all(|name| field(entry, name).is_some())
        {
            return Err(WorkerSchemaError::Mount.into());
        }
        let Some(Value(Node::Bool(read_only))) = field(entry, "readOnly") else {
            return Err(WorkerSchemaError::Mount.into());
        };
        let source = mount_path(field(entry, "source"))?;
        let target = mount_path(field(entry, "destination"))?;
        let destination =
            MountTarget::try_new(target.0.clone()).map_err(WorkerSchemaError::from)?;
        destination
            .worker_destination()
            .map_err(WorkerSchemaError::from)?;
        if !destinations.insert(destination.clone()) {
            return Err(WorkerSchemaError::Mount.into());
        }
        let mount = WorkerMount {
            source: MetadataText::from_text(source.clone()),
            destination,
            read_only: *read_only,
        };
        observe(&mount)?;
        mounts.push(mount);
    }
    Ok(mounts)
}
fn mount_path(value: Option<&Value>) -> Result<&Text> {
    let value = text(value).map_err(|_| WorkerSchemaError::Mount)?;
    if value.0.first() != Some(&47)
        || value.0.iter().any(|c| [0, 10, 13, 44].contains(c))
        || value.0.split(|&c| c == 47).any(|part| part == [46, 46])
    {
        return Err(WorkerSchemaError::Mount);
    }
    Ok(value)
}
/// Complete pure immutable-mount body, independent of seccomp custody. This
/// deliberately accepts partial configuration just as the original body did.
pub fn validate_rootless_mounts(config: &EffectiveWorkerConfig) -> Result<()> {
    let root = object(config.as_value()).ok_or(WorkerSchemaError::Mount)?;
    let values: &[Value] = match field(root, "mounts") {
        None => &[],
        Some(Value(Node::Array(values))) => values,
        _ => return Err(WorkerSchemaError::Mount),
    };
    let entries = values
        .iter()
        .map(|value| {
            let fields = object(value).ok_or(WorkerSchemaError::Mount)?;
            let target = MountTarget::try_new(text(field(fields, "destination"))?.0.clone())?;
            let readonly = matches!(field(fields, "readOnly"), Some(Value(Node::Bool(true))));
            Ok((target, readonly))
        })
        .collect::<Result<Vec<_>>>()?;
    require_immutable_mounts(
        &entries
            .iter()
            .map(|(target, readonly)| RootlessMount {
                target,
                read_only_is_true: *readonly,
            })
            .collect::<Vec<_>>(),
    )?;
    Ok(())
}
