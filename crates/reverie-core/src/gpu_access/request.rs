use super::{GpuAccessError, GpuDeviceUuid, MAX_REQUESTS, Result};
use crate::{
    decimal::UnsignedInteger,
    ids::ProfileSessionId,
    operations::{JournalDigest, JournalId},
    revision::{Generation, JS_SAFE_MAX},
};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GpuBinding {
    session: ProfileSessionId,
    generation: Generation,
    digest: JournalDigest,
}
impl GpuBinding {
    pub fn new(session: ProfileSessionId, generation: Generation, digest: JournalDigest) -> Self {
        Self {
            session,
            generation,
            digest,
        }
    }
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
    pub fn generation(&self) -> Generation {
        self.generation
    }
    pub fn digest(&self) -> &JournalDigest {
        &self.digest
    }
}
/// Client generation is deliberately unbounded positive decimal data. Only a
/// current native binding is limited to the source's safe integer ceiling.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GpuExpected {
    session: JournalId,
    generation: UnsignedInteger,
    digest: JournalDigest,
    revision: u64,
}
impl GpuExpected {
    pub fn try_new(
        session: JournalId,
        generation: UnsignedInteger,
        digest: JournalDigest,
        revision: u64,
    ) -> Result<Self> {
        if generation.is_zero() || revision >= JS_SAFE_MAX {
            return Err(GpuAccessError::RequestCasSchema);
        }
        Ok(Self {
            session,
            generation,
            digest,
            revision,
        })
    }
    pub fn session(&self) -> &JournalId {
        &self.session
    }
    pub fn generation(&self) -> &UnsignedInteger {
        &self.generation
    }
    pub fn digest(&self) -> &JournalDigest {
        &self.digest
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GpuIntent {
    expected: GpuExpected,
    device: Option<GpuDeviceUuid>,
}
impl GpuIntent {
    pub fn new(expected: GpuExpected, device: Option<GpuDeviceUuid>) -> Self {
        Self { expected, device }
    }
    pub fn expected(&self) -> &GpuExpected {
        &self.expected
    }
    pub fn device(&self) -> Option<&GpuDeviceUuid> {
        self.device.as_ref()
    }
    pub fn assert_current(
        &self,
        current: &GpuBinding,
        previous: Option<&GpuQueuedRequest>,
    ) -> Result<()> {
        if self.expected.session.as_str() != current.session.as_str()
            || self.expected.generation != UnsignedInteger::from_u64(current.generation.get())
            || self.expected.digest != current.digest
            || self.expected.revision != previous.map_or(0, GpuQueuedRequest::revision)
        {
            return Err(GpuAccessError::StaleRequest);
        }
        Ok(())
    }
    pub fn queued(
        &self,
        current: &GpuBinding,
        previous: Option<&GpuQueuedRequest>,
    ) -> Result<GpuQueuedRequest> {
        self.assert_current(current, previous)?;
        GpuQueuedRequest::try_new(
            self.expected.revision + 1,
            self.expected.session.clone(),
            current.generation,
            current.digest.clone(),
            self.device.clone(),
        )
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GpuQueuedRequest {
    revision: u64,
    session: JournalId,
    generation: Generation,
    digest: JournalDigest,
    device: Option<GpuDeviceUuid>,
}
impl GpuQueuedRequest {
    pub fn try_new(
        revision: u64,
        session: JournalId,
        generation: Generation,
        digest: JournalDigest,
        device: Option<GpuDeviceUuid>,
    ) -> Result<Self> {
        if !(1..=JS_SAFE_MAX).contains(&revision) {
            return Err(GpuAccessError::RequestStore);
        }
        Ok(Self {
            revision,
            session,
            generation,
            digest,
            device,
        })
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn session(&self) -> &JournalId {
        &self.session
    }
    pub fn generation(&self) -> Generation {
        self.generation
    }
    pub fn digest(&self) -> &JournalDigest {
        &self.digest
    }
    pub fn device(&self) -> Option<&GpuDeviceUuid> {
        self.device.as_ref()
    }
    pub fn matches_binding(&self, binding: &GpuBinding) -> bool {
        self.session.as_str() == binding.session.as_str()
            && self.generation == binding.generation
            && self.digest == binding.digest
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GpuRequestDocument(BTreeMap<JournalId, GpuQueuedRequest>);
impl GpuRequestDocument {
    pub fn empty() -> Self {
        Self(BTreeMap::new())
    }
    pub fn try_new(rows: BTreeMap<JournalId, GpuQueuedRequest>) -> Result<Self> {
        if rows.len() > MAX_REQUESTS {
            return Err(GpuAccessError::RequestStore);
        }
        Ok(Self(rows))
    }
    pub fn requests(&self) -> &BTreeMap<JournalId, GpuQueuedRequest> {
        &self.0
    }
    pub fn with_queued(&self, employee: JournalId, queued: GpuQueuedRequest) -> Result<Self> {
        let mut rows = self.0.clone();
        rows.insert(employee, queued);
        if rows.len() > MAX_REQUESTS {
            return Err(GpuAccessError::RequestStoreFull);
        }
        Ok(Self(rows))
    }
}
