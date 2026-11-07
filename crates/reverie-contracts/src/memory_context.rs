//! Closed installed-context v1 DATA, not a grant or an execution receipt.
//! Paths/owner text use codepoint arrays so JavaScript cannot combine adjacent
//! surrogate escapes or substitute invalid filesystem text during handoff.
use reverie_core::{
    PythonText,
    memory::{MemoryScope, ProjectName},
    memory_context::{EmployeeContext, InstalledMemoryContext, ScopeReference, ScopeResource},
    memory_instance::InstanceId,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;

pub const MAX_BYTES: usize = 131_072;
pub const INSTALLED_CONTEXT_PATH: &str = "/run/reverie/memory-context.json";
const SCHEMA: &str = "reverie-installed-memory-context-v1";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ContextCodecError;
impl fmt::Display for ContextCodecError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str("MEMORY_CONTEXT_INVALID")
    }
}
impl std::error::Error for ContextCodecError {}
type Result<T> = std::result::Result<T, ContextCodecError>;

/// Exact installed bytes only, not a canonical policy hash or permission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextFingerprint(String);
impl ContextFingerprint {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
pub fn fingerprint(raw: &[u8]) -> Result<ContextFingerprint> {
    if raw.len() > MAX_BYTES {
        return Err(ContextCodecError);
    }
    Ok(ContextFingerprint(crate::digest::hex(
        &Sha256::digest(raw).into(),
    )))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    schema: String,
    instance_ref: String,
    instance_id: String,
    employee: Employee,
    config_path_codepoints: Vec<u32>,
    resources: Vec<Resource>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Employee {
    owner_codepoints: Option<Vec<u32>>,
    employee_id: String,
    session_id: String,
    session_generation: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resource {
    resource_id: String,
    scope: Scope,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    kind: ScopeKind,
    #[serde(
        default,
        deserialize_with = "present_project",
        skip_serializing_if = "Option::is_none"
    )]
    project: Option<String>,
}
fn present_project<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(decoder).map(Some)
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum ScopeKind {
    Private,
    Project,
}
fn invalid<T>(result: std::result::Result<T, impl fmt::Display>) -> Result<T> {
    result.map_err(|_| ContextCodecError)
}

pub fn decode(raw: &[u8]) -> Result<InstalledMemoryContext> {
    if raw.len() > MAX_BYTES {
        return Err(ContextCodecError);
    }
    let document: Document = invalid(serde_json::from_slice(raw))?;
    if document.schema != SCHEMA {
        return Err(ContextCodecError);
    }
    let owner = document
        .employee
        .owner_codepoints
        .map(PythonText::try_new)
        .transpose();
    let employee = invalid(EmployeeContext::try_new(
        invalid(owner)?,
        invalid(ScopeReference::parse(&document.employee.employee_id))?,
        invalid(ScopeReference::parse(&document.employee.session_id))?,
        document.employee.session_generation,
    ))?;
    let resources = document
        .resources
        .into_iter()
        .map(|row| {
            let scope = match (row.scope.kind, row.scope.project) {
                (ScopeKind::Private, None) => MemoryScope::Private,
                (ScopeKind::Project, Some(project)) => {
                    MemoryScope::Project(ProjectName::parse(&project).ok_or(ContextCodecError)?)
                }
                _ => return Err(ContextCodecError),
            };
            Ok(ScopeResource::new(
                invalid(ScopeReference::parse(&row.resource_id))?,
                scope,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    invalid(InstalledMemoryContext::try_new(
        invalid(ScopeReference::parse(&document.instance_ref))?,
        invalid(InstanceId::parse(&document.instance_id))?,
        employee,
        invalid(PythonText::try_new(document.config_path_codepoints))?,
        resources,
    ))
}

fn document(context: &InstalledMemoryContext) -> Document {
    let employee = context.employee();
    Document {
        schema: SCHEMA.to_owned(),
        instance_ref: context.instance_ref().as_str().to_owned(),
        instance_id: context.instance().as_str().to_owned(),
        employee: Employee {
            owner_codepoints: employee.owner().map(|owner| owner.codepoints().to_vec()),
            employee_id: employee.employee().as_str().to_owned(),
            session_id: employee.session().as_str().to_owned(),
            session_generation: employee.generation(),
        },
        config_path_codepoints: context.configuration().codepoints().to_vec(),
        resources: context
            .resources()
            .iter()
            .map(|row| Resource {
                resource_id: row.resource().as_str().to_owned(),
                scope: match row.scope() {
                    MemoryScope::Private => Scope {
                        kind: ScopeKind::Private,
                        project: None,
                    },
                    MemoryScope::Project(project) => Scope {
                        kind: ScopeKind::Project,
                        project: Some(project.as_str().to_owned()),
                    },
                },
            })
            .collect(),
    }
}
pub fn encode(context: &InstalledMemoryContext) -> Result<Vec<u8>> {
    let bytes = invalid(serde_json::to_vec(&document(context)))?;
    if bytes.len() > MAX_BYTES {
        return Err(ContextCodecError);
    }
    Ok(bytes)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    schema: &'static str,
    installed: bool,
    office_api_url: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<SummaryData>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SummaryData {
    instance_ref: String,
    instance_id: String,
    employee: Employee,
    resources: Vec<Resource>,
    fingerprint: String,
}
/// Bootstrap metadata for the fixed MCP entry. Deliberately omits every path,
/// key and credential; successful decoding confers no authorization.
pub(crate) fn summary(context: Option<(&InstalledMemoryContext, &ContextFingerprint)>) -> Summary {
    let data = context.map(|(context, fingerprint)| {
        let document = document(context);
        SummaryData {
            instance_ref: document.instance_ref,
            instance_id: document.instance_id,
            employee: document.employee,
            resources: document.resources,
            fingerprint: fingerprint.as_str().to_owned(),
        }
    });
    Summary {
        schema: "reverie-installed-memory-summary-v1",
        installed: data.is_some(),
        office_api_url: reverie_core::worker_child::OFFICE_API_URL,
        data,
    }
}
