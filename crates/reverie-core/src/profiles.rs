use crate::ValueError;
use crate::ids::{ProfileEmployeeId, ProfileSessionId};
use crate::resources::ResourcePolicy;
use crate::revision::{Generation, ObservedProfileVersion, ProfileVersion, StoreRevision};
use std::collections::BTreeMap;
use std::fmt;

pub const MAX_PROFILES: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileBinding {
    employee: ProfileEmployeeId,
    current_session: ProfileSessionId,
    target_session: ProfileSessionId,
    current_generation: Generation,
    target_generation: Generation,
}
impl ProfileBinding {
    pub fn try_new(
        employee: ProfileEmployeeId,
        current_session: ProfileSessionId,
        target_session: ProfileSessionId,
        current_generation: Generation,
        target_generation: Generation,
    ) -> Result<Self, ValueError> {
        if target_generation < current_generation {
            return Err(ValueError::GenerationRegression);
        }
        Ok(Self {
            employee,
            current_session,
            target_session,
            current_generation,
            target_generation,
        })
    }
    pub fn employee(&self) -> &ProfileEmployeeId {
        &self.employee
    }
    pub fn current_session(&self) -> &ProfileSessionId {
        &self.current_session
    }
    pub fn target_session(&self) -> &ProfileSessionId {
        &self.target_session
    }
    pub fn current_generation(&self) -> Generation {
        self.current_generation
    }
    pub fn target_generation(&self) -> Generation {
        self.target_generation
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceProfile {
    version: ProfileVersion,
    resources: ResourcePolicy,
    binding: ProfileBinding,
}
impl ResourceProfile {
    /// Every component is already checked; composition is infallible.
    pub fn new(
        version: ProfileVersion,
        resources: ResourcePolicy,
        binding: ProfileBinding,
    ) -> Self {
        Self {
            version,
            resources,
            binding,
        }
    }
    pub fn version(&self) -> ProfileVersion {
        self.version
    }
    pub fn resources(&self) -> &ResourcePolicy {
        &self.resources
    }
    pub fn binding(&self) -> &ProfileBinding {
        &self.binding
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileError {
    InvalidValue(ValueError),
    ProfileCount,
    EmployeeBinding,
    StaleStoreRevision,
    StaleProfileVersion,
    StaleIdentityBinding,
}
impl ProfileError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidValue(error) => error.code(),
            Self::ProfileCount => "PROFILE_COUNT",
            Self::EmployeeBinding => "EMPLOYEE_BINDING",
            Self::StaleStoreRevision => "STALE_STORE_REVISION",
            Self::StaleProfileVersion => "STALE_PROFILE_VERSION",
            Self::StaleIdentityBinding => "STALE_IDENTITY_BINDING",
        }
    }
}
impl From<ValueError> for ProfileError {
    fn from(error: ValueError) -> Self {
        Self::InvalidValue(error)
    }
}
impl fmt::Display for ProfileError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for ProfileError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileDocument {
    revision: StoreRevision,
    profiles: BTreeMap<ProfileEmployeeId, ResourceProfile>,
}
impl ProfileDocument {
    pub fn empty() -> Self {
        Self {
            revision: StoreRevision::ZERO,
            profiles: BTreeMap::new(),
        }
    }
    pub fn try_new(
        revision: StoreRevision,
        profiles: BTreeMap<ProfileEmployeeId, ResourceProfile>,
    ) -> Result<Self, ProfileError> {
        if profiles.len() > MAX_PROFILES {
            return Err(ProfileError::ProfileCount);
        }
        if profiles
            .iter()
            .any(|(employee, profile)| employee != profile.binding().employee())
        {
            return Err(ProfileError::EmployeeBinding);
        }
        Ok(Self { revision, profiles })
    }
    pub fn revision(&self) -> StoreRevision {
        self.revision
    }
    pub fn profiles(&self) -> &BTreeMap<ProfileEmployeeId, ResourceProfile> {
        &self.profiles
    }
    /// Pure CAS projection only. The store must perform its real locked CAS and
    /// custody checks; this value is not a write or native-effect capability.
    pub fn apply(&self, change: &ProfilePutIntent) -> Result<Self, ProfileError> {
        if self.revision != change.expected_revision {
            return Err(ProfileError::StaleStoreRevision);
        }
        let old = self.profiles.get(&change.employee);
        if old.map_or(0, |profile| profile.version.get()) != change.expected_profile_version.get() {
            return Err(ProfileError::StaleProfileVersion);
        }
        if old.map(ResourceProfile::binding) != change.expected_binding.as_ref() {
            return Err(ProfileError::StaleIdentityBinding);
        }
        let version = ProfileVersion::try_new(change.expected_profile_version.get() + 1)?;
        let profile =
            ResourceProfile::new(version, change.resources.clone(), change.binding.clone());
        let mut profiles = self.profiles.clone();
        profiles.insert(change.employee.clone(), profile);
        Self::try_new(self.revision.checked_next()?, profiles)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfilePutIntent {
    employee: ProfileEmployeeId,
    resources: ResourcePolicy,
    binding: ProfileBinding,
    expected_revision: StoreRevision,
    expected_profile_version: ObservedProfileVersion,
    expected_binding: Option<ProfileBinding>,
}
impl ProfilePutIntent {
    pub fn try_new(
        employee: ProfileEmployeeId,
        resources: ResourcePolicy,
        binding: ProfileBinding,
        expected_revision: StoreRevision,
        expected_profile_version: ObservedProfileVersion,
        expected_binding: Option<ProfileBinding>,
    ) -> Result<Self, ProfileError> {
        if binding.employee() != &employee {
            return Err(ProfileError::EmployeeBinding);
        }
        Ok(Self {
            employee,
            resources,
            binding,
            expected_revision,
            expected_profile_version,
            expected_binding,
        })
    }
}
