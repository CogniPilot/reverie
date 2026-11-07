use super::*;
use crate::operations::JournalId;
use std::collections::BTreeSet;
/// Sanitized catalogue DATA, not a host observation or permission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GpuChoice {
    device: GpuDeviceUuid,
    model: String,
}
impl GpuChoice {
    pub fn try_new(device: GpuDeviceUuid, model: String) -> Result<Self> {
        if model.len() > 96 || !model.bytes().all(|byte| (32..=126).contains(&byte)) {
            return Err(GpuAccessError::StatusData);
        }
        Ok(Self { device, model })
    }
    pub fn device(&self) -> &GpuDeviceUuid {
        &self.device
    }
    pub fn model(&self) -> &str {
        &self.model
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GpuChoicesData(Option<Vec<GpuChoice>>);
impl GpuChoicesData {
    pub fn unknown() -> Self {
        Self(None)
    }
    pub fn known(mut devices: Vec<GpuChoice>) -> Result<Self> {
        if devices.len() > 32
            || devices
                .iter()
                .map(GpuChoice::device)
                .collect::<BTreeSet<_>>()
                .len()
                != devices.len()
        {
            return Err(GpuAccessError::StatusData);
        }
        devices.sort_by(|left, right| left.device.cmp(&right.device));
        Ok(Self(Some(devices)))
    }
    pub fn devices(&self) -> Option<&[GpuChoice]> {
        self.0.as_deref()
    }
}
/// Owner-facing status DATA only. The application must obtain positive facts
/// from actual physical/process/node observations; no variant is a start grant.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GpuActiveData {
    Stopped,
    UnknownRunning,
    ObservedDevice(GpuDeviceUuid),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GpuStatusState {
    Unchanged,
    Applied,
    Pending,
}
impl GpuStatusState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unchanged => "unchanged",
            Self::Applied => "applied",
            Self::Pending => "pending",
        }
    }
}
pub struct GpuStatusData {
    employee: JournalId,
    current: GpuBinding,
    requested: Option<GpuQueuedRequest>,
    choices: GpuChoicesData,
    applied: GpuApplied,
    active: GpuActiveData,
}
impl GpuStatusData {
    pub fn new(
        employee: JournalId,
        current: GpuBinding,
        requested: Option<GpuQueuedRequest>,
        choices: GpuChoicesData,
        applied: GpuApplied,
        active: GpuActiveData,
    ) -> Result<Self> {
        if let GpuActiveData::ObservedDevice(device) = &active
            && applied.device() != Some(device)
        {
            return Err(GpuAccessError::StatusData);
        }
        Ok(Self {
            employee,
            current,
            requested,
            choices,
            applied,
            active,
        })
    }
    pub fn employee(&self) -> &JournalId {
        &self.employee
    }
    pub fn current(&self) -> &GpuBinding {
        &self.current
    }
    pub fn requested(&self) -> Option<&GpuQueuedRequest> {
        self.requested.as_ref()
    }
    pub fn choices(&self) -> &GpuChoicesData {
        &self.choices
    }
    pub fn applied(&self) -> &GpuApplied {
        &self.applied
    }
    pub fn active(&self) -> &GpuActiveData {
        &self.active
    }
    /// Source intentionally reports old queued intent without rebinding it.
    /// Device equality determines this label even when its session is stale.
    pub fn state(&self) -> GpuStatusState {
        match &self.requested {
            None => GpuStatusState::Unchanged,
            Some(value) if value.device() == self.applied.device() => GpuStatusState::Applied,
            Some(_) => GpuStatusState::Pending,
        }
    }
}
