//! Expected boot-layout header DATA shared by the actual started inspectors.
use super::*;
use crate::worker_launch::WorkerInitData;

pub(super) fn configuration(
    fields: &Object,
    original: &Object,
    config: &Object,
    init: WorkerInitData,
) -> Result<()> {
    let account = format!(
        "{}:{}",
        account(original, "uid")?,
        account(original, "gid")?
    );
    let wanted = [
        ("User", Value(Node::String(key(&account)))),
        (
            "Entrypoint",
            Value(Node::Array(vec![Value(Node::String(key(
                init.entrypoint()
            )))])),
        ),
    ];
    for (name, expected) in wanted {
        if !field(config, name).is_some_and(|actual| actual.python_eq(&expected)) {
            return Err(ColdDataError::Inventory);
        }
    }
    let command = Value(Node::Array(
        init.command()
            .iter()
            .map(|argument| Value(Node::String(key(argument))))
            .collect(),
    ));
    let actual = field(config, "Cmd").ok_or(ColdDataError::Inventory)?;
    let sealed = init == crate::worker_launch::WorkerInitData::SealedNative;
    if !(actual.python_eq(&command) || sealed && matches!(actual.0, Node::Null)) {
        return Err(ColdDataError::Inventory);
    }
    if sealed {
        let host = field(fields, "HostConfig")
            .and_then(object)
            .ok_or(ColdDataError::Inventory)?;
        if !matches!(field(host, "Init"), Some(Value(Node::Bool(false)))) {
            return Err(ColdDataError::Policy);
        }
    }
    Ok(())
}
