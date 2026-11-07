//! Installed memory selection DATA. These checked values authenticate nobody;
//! each use still requires the canonical current employee/service-grant policy.
use crate::{PythonText, memory::MemoryScope, memory_instance::InstanceId};
use std::fmt;

/// Existing MCP client switches. These relax no server-side permission check.
#[derive(Clone, Debug, Default)]
pub struct McpOptions {
    pub url: Option<String>,
    pub allow_any_session: bool,
    pub chat: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ContextError;
impl fmt::Display for ContextError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str("MEMORY_CONTEXT")
    }
}
impl std::error::Error for ContextError {}

/// The existing service-grant reference grammar, including opaque legacy IDs.
/// This is deliberately distinct from UUID-only resource-operation identities.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScopeReference(String);
impl ScopeReference {
    pub fn parse(value: &str) -> Result<Self, ContextError> {
        if value.is_empty()
            || value.len() > 100
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
            })
        {
            return Err(ContextError);
        }
        Ok(Self(value.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Observed binding labels. Construction is not a grant or issuer validation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmployeeContext {
    owner: Option<PythonText>,
    employee: ScopeReference,
    session: ScopeReference,
    generation: u64,
}
impl EmployeeContext {
    pub fn try_new(
        owner: Option<PythonText>,
        employee: ScopeReference,
        session: ScopeReference,
        generation: u64,
    ) -> Result<Self, ContextError> {
        if generation == 0 || generation > 9_007_199_254_740_991 {
            return Err(ContextError);
        }
        Ok(Self {
            owner,
            employee,
            session,
            generation,
        })
    }
    pub fn owner(&self) -> Option<&PythonText> {
        self.owner.as_ref()
    }
    pub fn employee(&self) -> &ScopeReference {
        &self.employee
    }
    pub fn session(&self) -> &ScopeReference {
        &self.session
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScopeResource {
    resource: ScopeReference,
    scope: MemoryScope,
}
impl ScopeResource {
    pub fn new(resource: ScopeReference, scope: MemoryScope) -> Self {
        Self { resource, scope }
    }
    pub fn resource(&self) -> &ScopeReference {
        &self.resource
    }
    pub fn scope(&self) -> &MemoryScope {
        &self.scope
    }
}

/// One existing instance and its guest-interpreted path. No host path, key,
/// grant, expiry, allow flag, readiness proof or arbitrary environment is stored.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstalledMemoryContext {
    instance_ref: ScopeReference,
    instance: InstanceId,
    employee: EmployeeContext,
    configuration: PythonText,
    resources: Vec<ScopeResource>,
}
impl InstalledMemoryContext {
    pub fn try_new(
        instance_ref: ScopeReference,
        instance: InstanceId,
        employee: EmployeeContext,
        configuration: PythonText,
        resources: Vec<ScopeResource>,
    ) -> Result<Self, ContextError> {
        let path = configuration.codepoints();
        if path.first() != Some(&47)
            || path.contains(&0)
            || resources.is_empty()
            || resources.len() > 256
        {
            return Err(ContextError);
        }
        for (index, resource) in resources.iter().enumerate() {
            if resources[..index]
                .iter()
                .any(|prior| prior.resource == resource.resource || prior.scope == resource.scope)
            {
                return Err(ContextError);
            }
        }
        Ok(Self {
            instance_ref,
            instance,
            employee,
            configuration,
            resources,
        })
    }
    pub fn instance(&self) -> &InstanceId {
        &self.instance
    }
    /// Deployment-local selection reference; never rewrites the existing ID.
    pub fn instance_ref(&self) -> &ScopeReference {
        &self.instance_ref
    }
    pub fn employee(&self) -> &EmployeeContext {
        &self.employee
    }
    pub fn configuration(&self) -> &PythonText {
        &self.configuration
    }
    pub fn resources(&self) -> &[ScopeResource] {
        &self.resources
    }
    pub fn resource_for(&self, scope: &MemoryScope) -> Option<&ScopeReference> {
        self.resources
            .iter()
            .find(|row| row.scope() == scope)
            .map(ScopeResource::resource)
    }
}
