//! Closed known-history DATA only. These checks cannot establish filesystem
//! custody, completed native work, permission to replay or an admission grant.
use super::*;
use reverie_core::{
    ids::{ProfileEmployeeId, ProfileSessionId},
    operations::{JournalDigest, JournalId},
};
mod resume_retained;
pub use resume_retained::RetainedExpiredResumeData;

pub fn require_empty_operations(raw: &[u8]) -> SetupResult<()> {
    let document = crate::operations_v1::decode(raw).map_err(ActorSetupDataError::Operation)?;
    need_setup(
        document.revision().get() == 0 && document.operations().is_empty(),
        "ACTOR_SETUP_RETAINED_OPERATIONS",
    )
}
pub fn require_empty_profiles(raw: &[u8]) -> SetupResult<()> {
    let document = crate::profiles_v1::decode(raw).map_err(ActorSetupDataError::Profiles)?;
    need_setup(
        document.revision().get() == 0 && document.profiles().is_empty(),
        "ACTOR_SETUP_RETAINED_PROFILES",
    )
}
pub fn validate_task_perf_requests(raw: &[u8]) -> SetupResult<()> {
    let value = parsed(raw)?;
    checked(closed(&value, &["schema", "requests"]))?;
    let fields = checked(object(&value))?;
    literal(
        field(fields, "schema")?,
        "reverie-owner-task-perf-requests-v1",
    )?;
    let rows = checked(object(field(fields, "requests")?))?;
    need_setup(rows.len() <= 256, "ACTOR_SETUP_PERF_QUEUE_BOUND")?;
    for (employee, row) in rows {
        ProfileEmployeeId::parse(&checked(scalar(&Value(Node::String(employee.clone()))))?)
            .map_err(|_| ActorSetupDataError::Refused("ACTOR_SETUP_PERF_QUEUE"))?;
        checked(closed(
            row,
            &[
                "revision",
                "sessionId",
                "sessionGeneration",
                "bindingDigest",
                "policy",
            ],
        ))?;
        let row = checked(object(row))?;
        ProfileSessionId::parse(&checked(scalar(field(row, "sessionId")?))?)
            .map_err(|_| ActorSetupDataError::Refused("ACTOR_SETUP_PERF_QUEUE"))?;
        positive(field(row, "revision")?)?;
        positive(field(row, "sessionGeneration")?)?;
        JournalDigest::parse(&checked(scalar(field(row, "bindingDigest")?))?)
            .map_err(|_| ActorSetupDataError::Refused("ACTOR_SETUP_PERF_QUEUE"))?;
        need_setup(
            matches!(&field(row, "policy")?.0, Node::Null)
                || matches!(&field(row, "policy")?.0, Node::String(value) if value.equals_ascii("task-v1")),
            "ACTOR_SETUP_PERF_QUEUE",
        )?;
    }
    Ok(())
}
pub fn require_resume_namespace(raw: &[u8], directory: [u64; 4]) -> SetupResult<()> {
    let value = parsed(raw)?;
    checked(closed(&value, &["version", "purpose", "directory"]))?;
    let fields = checked(object(&value))?;
    version(field(fields, "version")?)?;
    literal(field(fields, "purpose")?, crate::worker_resume::PURPOSE)?;
    let Node::Array(actual) = &field(fields, "directory")?.0 else {
        return Err(ActorSetupDataError::Refused("ACTOR_SETUP_RESUME_NAMESPACE"));
    };
    need_setup(
        actual.len() == directory.len()
            && actual.iter().zip(directory).all(|(value, expected)| {
                value.python_eq(&Value(Node::Number(Number::Integer(expected.to_string()))))
            }),
        "ACTOR_SETUP_RESUME_NAMESPACE",
    )
}
pub fn require_resume_complete(
    raw: &[u8],
    operation: &JournalId,
    plan: &JournalDigest,
    result: &JournalDigest,
) -> SetupResult<()> {
    let value = parsed(raw)?;
    checked(closed(
        &value,
        &[
            "version",
            "purpose",
            "operationId",
            "planDigest",
            "resultDigest",
        ],
    ))?;
    let fields = checked(object(&value))?;
    need_setup(
        matches!(&field(fields, "version")?.0, Node::Number(Number::Integer(value)) if value == "1"),
        "ACTOR_SETUP_RESUME_COMPLETE_VERSION",
    )?;
    for (name, expected) in [
        ("purpose", crate::worker_resume::PURPOSE),
        ("operationId", operation.as_str()),
        ("planDigest", plan.as_str()),
        ("resultDigest", result.as_str()),
    ] {
        literal(field(fields, name)?, expected)?;
    }
    Ok(())
}
fn parsed(raw: &[u8]) -> SetupResult<Value> {
    need_setup(raw.len() <= 65_536, "ACTOR_SETUP_HISTORY_BOUND")?;
    legacy_json::decode_strict_bytes(raw)
        .map_err(|_| ActorSetupDataError::Refused("ACTOR_SETUP_HISTORY_JSON"))
}
fn checked<T>(result: Result<T>) -> SetupResult<T> {
    result.map_err(ActorSetupDataError::Actor)
}
fn field<'a>(fields: &'a BTreeMap<Text, Value>, name: &str) -> SetupResult<&'a Value> {
    fields
        .get(&key(name))
        .ok_or(ActorSetupDataError::Refused("ACTOR_SETUP_HISTORY_SCHEMA"))
}
fn literal(value: &Value, expected: &str) -> SetupResult<()> {
    need_setup(
        matches!(&value.0, Node::String(value) if value.equals_ascii(expected)),
        "ACTOR_SETUP_HISTORY_SCHEMA",
    )
}
fn positive(value: &Value) -> SetupResult<()> {
    let actual = checked(unsigned(value))?.to_u64();
    need_setup(
        actual.is_some_and(|value| value > 0 && value <= reverie_core::revision::JS_SAFE_MAX),
        "ACTOR_SETUP_PERF_QUEUE",
    )
}
fn version(value: &Value) -> SetupResult<()> {
    need_setup(
        value.python_eq(&Value(Node::Number(Number::Integer("1".into())))),
        "ACTOR_SETUP_RESUME_NAMESPACE",
    )
}
