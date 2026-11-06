use super::*;
const BASE: [&str; 5] = ["kind", "version", "requestId", "action", "resourceId"];
const EFFECT: [&str; 5] = [
    "grantRef",
    "idempotencyKey",
    "artifact",
    "expectedResourceGeneration",
    "expectedCapabilityGeneration",
];
fn field<'a>(fields: &'a Object, name: &str) -> Result<&'a Value> {
    fields.get(&key(name)).ok_or(OpsDataError::Shape)
}
fn object(value: &Value) -> Result<&Object> {
    match &value.0 {
        Node::Object(fields) => Ok(fields),
        _ => Err(OpsDataError::Shape),
    }
}
fn shape(fields: &Object, expected: &[&str]) -> Result<()> {
    if fields.len() != expected.len()
        || expected.iter().any(|name| !fields.contains_key(&key(name)))
    {
        return Err(OpsDataError::Shape);
    }
    Ok(())
}
fn identifier(value: &Value) -> Result<()> {
    let Node::String(value) = &value.0 else {
        return Err(OpsDataError::Identifier);
    };
    let text = value
        .0
        .iter()
        .copied()
        .map(char::from_u32)
        .collect::<Option<String>>()
        .ok_or(OpsDataError::Identifier)?;
    OpsServiceId::parse(&text)
        .map(|_| ())
        .map_err(|_| OpsDataError::Identifier)
}
fn digest(value: &Value) -> Result<()> {
    let Node::String(value) = &value.0 else {
        return Err(OpsDataError::Digest);
    };
    let text = &value.0;
    if text.len() != 71
        || !text[..7]
            .iter()
            .copied()
            .eq("sha256:".chars().map(u32::from))
        || !text[7..]
            .iter()
            .all(|&point| matches!(point,48..=57|97..=102))
    {
        return Err(OpsDataError::Digest);
    }
    Ok(())
}
pub(super) fn command(value: &Value) -> Result<OpsAction> {
    let fields = object(value)?;
    if !matches!(&field(fields,"kind")?.0,Node::String(value) if value.equals_ascii("reverie.ops.command"))
        || !matches!(&field(fields,"version")?.0,Node::Number(Number::Integer(value)) if value=="1")
    {
        return Err(OpsDataError::Shape);
    }
    let action = OpsAction::parse(field(fields, "action")?)?;
    let mut expected = BASE.to_vec();
    if action == OpsAction::Inspect {
        let operation = fields.contains_key(&key("operationId"));
        let lookup = fields.contains_key(&key("lookupIdempotencyKey"));
        if operation == lookup {
            return Err(OpsDataError::Shape);
        }
        expected.push(if operation {
            "operationId"
        } else {
            "lookupIdempotencyKey"
        });
    }
    if action.is_effect() {
        expected.extend(EFFECT);
    }
    shape(fields, &expected)?;
    for name in [
        "requestId",
        "resourceId",
        "operationId",
        "lookupIdempotencyKey",
        "idempotencyKey",
    ] {
        if let Some(value) = fields.get(&key(name)) {
            identifier(value)?;
        }
    }
    if action.is_effect() {
        effect(fields)?;
    }
    Ok(action)
}
fn effect(fields: &Object) -> Result<()> {
    let grant = object(field(fields, "grantRef")?)?;
    shape(grant, &["grantId", "policyGeneration"])?;
    identifier(field(grant, "grantId")?)?;
    digest(field(grant, "policyGeneration")?)?;
    let artifact = object(field(fields, "artifact")?)?;
    shape(artifact, &["artifactId", "digest", "reviewId"])?;
    identifier(field(artifact, "artifactId")?)?;
    identifier(field(artifact, "reviewId")?)?;
    digest(field(artifact, "digest")?)?;
    digest(field(fields, "expectedResourceGeneration")?)?;
    digest(field(fields, "expectedCapabilityGeneration")?)
}
