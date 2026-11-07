use super::*;
use crate::{
    reservation_control,
    storage_identity::{CurrentEmployee, Metadata},
    worker_config::{EffectiveWorkerConfig, WorkerPolicyDigest},
};
use reverie_core::{
    gpu_access::GpuBinding,
    ids::ProfileSessionId,
    operations::{JournalDigest, JournalId},
    revision::Generation,
};

/// First registry selection at the source `_current` phase. The actual native
/// current_employee resolver must subsequently perform its two observations;
/// this one selected SID is DATA and is never a native binding proof.
pub fn current_session(company: &Metadata, employee: &JournalId) -> Result<ProfileSessionId> {
    let Some(Value(Node::Array(rows))) =
        object(company.as_value()).and_then(|fields| field(fields, "employees"))
    else {
        return Err(GpuDataError::CurrentRegistry);
    };
    if rows.len() > 256 {
        return Err(GpuDataError::CurrentRegistry);
    }
    let mut matches = rows
        .iter()
        .filter_map(object)
        .filter(|row| field(row, "id").and_then(text).as_deref() == Some(employee.as_str()));
    let row = matches.next().ok_or(GpuDataError::CurrentEmployee)?;
    if matches.next().is_some() {
        return Err(GpuDataError::CurrentEmployee);
    }
    let sid = field(row, "sessionId")
        .and_then(text)
        .ok_or(GpuDataError::CurrentEmployee)?;
    ProfileSessionId::parse(&sid).map_err(|_| GpuDataError::CurrentEmployee)
}
/// Checked current-generation DATA; the native resolver still owns both
/// observations and this wrapper confers no GPU authority.
pub struct GpuCurrentEmployee {
    current: CurrentEmployee,
    generation: Generation,
}
impl GpuCurrentEmployee {
    pub fn from_current(current: CurrentEmployee, employee: &JournalId) -> Result<Self> {
        if current.identity().as_str() != employee.as_str() {
            return Err(GpuDataError::CurrentEmployee);
        }
        let generation = current
            .generation()
            .decimal()
            .parse::<u64>()
            .ok()
            .and_then(|value| Generation::try_new(value).ok())
            .ok_or(GpuDataError::CurrentGeneration)?;
        Ok(Self {
            current,
            generation,
        })
    }
    pub fn data(&self) -> &CurrentEmployee {
        &self.current
    }
    pub fn generation(&self) -> Generation {
        self.generation
    }
}
/// Exact finite compact `J.fingerprint({current,domain,policy})`. The policy
/// digest is the result of the real effective-config resolver at this phase;
/// passing a digest is not an authority or an observation receipt.
pub fn current_binding(
    config: &EffectiveWorkerConfig,
    selected: &GpuCurrentEmployee,
    policy: &WorkerPolicyDigest,
) -> Result<GpuBinding> {
    let generation = selected.generation;
    let current = &selected.current;
    let owner = current.owner().as_ref().map_or(Value(Node::Null), |owner| {
        Value(Node::String(Text(owner.codepoints().to_vec())))
    });
    let observed = Value(Node::Object(
        [
            (key("id"), string(current.identity().as_str())),
            (key("sessionId"), string(current.session().as_str())),
            (key("sessionGeneration"), number(generation.get())),
            (key("owner"), owner),
        ]
        .into(),
    ));
    let domain =
        reservation_control::domain_digest(config).map_err(|_| GpuDataError::Configuration)?;
    let value = Value(Node::Object(
        [
            (key("current"), observed),
            (key("domain"), string(&domain.to_hex())),
            (key("policy"), string(&policy.to_hex())),
        ]
        .into(),
    ));
    let digest =
        reservation_control::fingerprint(&value).map_err(|_| GpuDataError::Configuration)?;
    Ok(GpuBinding::new(
        current.session().clone(),
        generation,
        JournalDigest::parse(&crate::digest::hex(&digest))?,
    ))
}
