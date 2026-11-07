use super::*;
use crate::storage_identity::Metadata;
/// Exact comparison bytes from the original nine-field default-spaced JSON
/// projection. This is data, never an employee, owner or launch credential.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaunchWaitBinding(Vec<u8>);
impl LaunchWaitBinding {
    pub fn bytes(&self) -> &[u8] {
        &self.0
    }
}
pub fn launch_wait_binding(
    metadata: &Metadata,
    session: &ProfileSessionId,
) -> Result<Option<LaunchWaitBinding>> {
    let root = object(metadata.as_value())?;
    let Some(Value(Node::Array(rows))) = field(root, "employees") else {
        return Err(WriterDataError::WaitBinding);
    };
    let rows = rows
        .iter()
        .map(|row| object(row).map_err(|_| WriterDataError::WaitBinding))
        .collect::<Result<Vec<_>>>()?;
    let selected = rows
        .into_iter()
        .filter(|row| text_is(field(row, "sessionId"), session.as_str()))
        .collect::<Vec<_>>();
    if selected.len() > 1 {
        return Err(WriterDataError::WaitBinding);
    }
    let Some(selected) = selected.first() else {
        return Ok(None);
    };
    let fields = [
        "id",
        "owner",
        "sessionId",
        "sessionGeneration",
        "desiredRunning",
        "onVacation",
        "bindingMigration",
        "runtimeRecipe",
        "permissions",
    ];
    let projected = Value(Node::Object(
        fields
            .into_iter()
            .map(|name| {
                (
                    key(name),
                    field(selected, name).map_or(Value(Node::Null), Value::deep_clone),
                )
            })
            .collect(),
    ));
    Ok(Some(LaunchWaitBinding(crate::worker_config::encode_data(
        &projected,
    ))))
}
