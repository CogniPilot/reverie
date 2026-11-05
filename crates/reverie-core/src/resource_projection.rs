//! Pure resource-map projection, not full worker configuration or effect authority.
use crate::ValueError;
use crate::ids::{ProfileEmployeeId, ProfileSessionId};
use crate::profiles::{MAX_PROFILES, ProfileBinding, ProfileDocument, ResourceProfile};
use crate::resources::{PoolLimits, ResourceTemplate};
use crate::revision::{ObservedProfileVersion, ProfileVersion, StoreRevision};
use std::collections::BTreeMap;
use std::fmt;

pub const MAX_SESSION_POLICIES: usize = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectionError {
    InvalidValue(ValueError),
    SessionPolicyCount,
    EmployeePolicyCount,
    EmployeeBinding,
    StaleStoreRevision,
    PendingProfileMissingNoDefault,
    StaleProfileOrBinding,
    SidOwnerMismatch,
}
impl ProjectionError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidValue(error) => error.code(),
            Self::SessionPolicyCount => "SESSION_POLICY_COUNT",
            Self::EmployeePolicyCount => "EMPLOYEE_POLICY_COUNT",
            Self::EmployeeBinding => "EMPLOYEE_BINDING",
            Self::StaleStoreRevision => "STALE_STORE_REVISION",
            Self::PendingProfileMissingNoDefault => "PENDING_PROFILE_MISSING_NO_DEFAULT",
            Self::StaleProfileOrBinding => "STALE_PROFILE_OR_BINDING",
            Self::SidOwnerMismatch => "SID_OWNER_MISMATCH",
        }
    }
}
impl From<ValueError> for ProjectionError {
    fn from(error: ValueError) -> Self {
        Self::InvalidValue(error)
    }
}
impl fmt::Display for ProjectionError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for ProjectionError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceProjection {
    sessions: BTreeMap<ProfileSessionId, ResourceTemplate>,
    employees: BTreeMap<ProfileEmployeeId, ResourceTemplate>,
    reservation_pool: Option<PoolLimits>,
}
impl ResourceProjection {
    /// `Some` means the configuration contains `resourceReservations`, regardless
    /// of that option's value. Its adapter must supply the checked global pool.
    pub fn try_new(
        sessions: BTreeMap<ProfileSessionId, ResourceTemplate>,
        employees: BTreeMap<ProfileEmployeeId, ResourceTemplate>,
        reservation_pool: Option<PoolLimits>,
    ) -> Result<Self, ProjectionError> {
        if sessions.len() > MAX_SESSION_POLICIES {
            return Err(ProjectionError::SessionPolicyCount);
        }
        if employees.len() > MAX_PROFILES {
            return Err(ProjectionError::EmployeePolicyCount);
        }
        for template in sessions.values().chain(employees.values()) {
            template.resolve(reservation_pool)?;
        }
        Ok(Self {
            sessions,
            employees,
            reservation_pool,
        })
    }
    pub fn sessions(&self) -> &BTreeMap<ProfileSessionId, ResourceTemplate> {
        &self.sessions
    }
    pub fn employees(&self) -> &BTreeMap<ProfileEmployeeId, ResourceTemplate> {
        &self.employees
    }
    pub fn reservation_pool(&self) -> Option<PoolLimits> {
        self.reservation_pool
    }

    /// Only the selected employee and target session are replaced. The input
    /// profile and other entries retain their exact resource encoding provenance.
    pub fn stage(
        &self,
        document: &ProfileDocument,
        request: &ProfileStageRequest,
    ) -> Result<StagedResourceProjection, ProjectionError> {
        if document.revision() != request.expected_revision {
            return Err(ProjectionError::StaleStoreRevision);
        }
        let profile = document
            .profiles()
            .get(&request.employee)
            .ok_or(ProjectionError::PendingProfileMissingNoDefault)?;
        if profile.version().get() != request.expected_profile_version.get()
            || profile.binding() != &request.binding
        {
            return Err(ProjectionError::StaleProfileOrBinding);
        }
        if request.current_owner.as_ref() != Some(&request.employee)
            || request.target_owner.as_ref() != Some(&request.employee)
        {
            return Err(ProjectionError::SidOwnerMismatch);
        }
        let resources =
            ResourceTemplate::from(profile.resources()).resolve(self.reservation_pool)?;
        let mut sessions = self.sessions.clone();
        let mut employees = self.employees.clone();
        sessions.insert(
            request.binding.target_session().clone(),
            ResourceTemplate::from(&resources),
        );
        employees.insert(request.employee.clone(), ResourceTemplate::from(&resources));
        let projection = Self::try_new(sessions, employees, self.reservation_pool)?;
        Ok(StagedResourceProjection {
            projection,
            profile: profile.clone(),
            store_revision: document.revision(),
        })
    }
}

/// A bounded copy of trusted canonical binding/owner inputs. These data do not
/// authenticate their source or grant permission to stage, write or restart.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileStageRequest {
    employee: ProfileEmployeeId,
    binding: ProfileBinding,
    expected_revision: StoreRevision,
    expected_profile_version: ObservedProfileVersion,
    current_owner: Option<ProfileEmployeeId>,
    target_owner: Option<ProfileEmployeeId>,
}
impl ProfileStageRequest {
    pub fn try_new(
        employee: ProfileEmployeeId,
        binding: ProfileBinding,
        expected_revision: StoreRevision,
        expected_profile_version: ObservedProfileVersion,
        sid_owners: &BTreeMap<ProfileSessionId, ProfileEmployeeId>,
    ) -> Result<Self, ProjectionError> {
        if binding.employee() != &employee {
            return Err(ProjectionError::EmployeeBinding);
        }
        Ok(Self {
            current_owner: sid_owners.get(binding.current_session()).cloned(),
            target_owner: sid_owners.get(binding.target_session()).cloned(),
            employee,
            binding,
            expected_revision,
            expected_profile_version,
        })
    }
}

/// Resource-domain candidate only. Full staging still needs held store custody,
/// host-backed GPU/perf/storage/lease projections and the legacy effective hash.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StagedResourceProjection {
    projection: ResourceProjection,
    profile: ResourceProfile,
    store_revision: StoreRevision,
}
impl StagedResourceProjection {
    pub fn projection(&self) -> &ResourceProjection {
        &self.projection
    }
    /// Original canonical profile, before reservation-pool projection.
    pub fn profile(&self) -> &ResourceProfile {
        &self.profile
    }
    pub fn store_revision(&self) -> StoreRevision {
        self.store_revision
    }
    pub fn target_session(&self) -> &ProfileSessionId {
        self.profile.binding().target_session()
    }
    pub fn profile_version(&self) -> ProfileVersion {
        self.profile.version()
    }
}
