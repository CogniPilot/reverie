use super::*;
fn object(value: &mut Value) -> Result<&mut Object> {
    match &mut value.0 {
        Node::Object(value) => Ok(value),
        _ => Err(PublicationDataError::Recipe),
    }
}
pub(super) fn fresh(value: &mut Value) -> Result<()> {
    let row = object(value)?;
    let mode = match row.get(&key("mode")) {
        Some(Value(Node::String(value))) if value.equals_ascii("claude") => false,
        Some(Value(Node::String(value))) if value.equals_ascii("codex") => true,
        _ => return Err(PublicationDataError::Recipe),
    };
    row.insert(key("runtimeThreads"), Value(Node::Object(Object::new())));
    if !mode {
        return Ok(());
    }
    let Some(configs) = row.get_mut(&key("configs")) else {
        return Ok(());
    };
    let configs = object(configs)?;
    let Some(config) = configs.get_mut(&key("codexConfig")) else {
        return Ok(());
    };
    if matches!(config.0, Node::Null) {
        return Ok(());
    }
    object(config)?.remove(&key("resumeSessionId"));
    Ok(())
}
