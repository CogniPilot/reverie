use super::*;
use crate::reservation_engine::ObservedMemoryPolicy;
use crate::resource_config::ResourceConfiguration;
use reverie_core::decimal::UnsignedInteger;

#[derive(Debug)]
pub enum PoolConfigurationDataError {
    Refused(&'static str),
    Policy(PoolPolicyError),
    Resources(ResourceConfigError),
    Memory(DeviceConfigError),
    Control(ControlDataError),
    Engine(crate::reservation_engine::EngineDataError),
}
impl PoolConfigurationDataError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Policy(_) => "WORKER_POOL_CONFIGURATION_POLICY",
            Self::Resources(error) => error.code(),
            Self::Memory(error) => error.code(),
            Self::Control(error) => error.code(),
            Self::Engine(error) => error.code(),
        }
    }
}
impl std::fmt::Display for PoolConfigurationDataError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for PoolConfigurationDataError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Refused(_) => None,
            Self::Policy(error) => Some(error),
            Self::Resources(error) => Some(error),
            Self::Memory(error) => Some(error),
            Self::Control(error) => Some(error),
            Self::Engine(error) => Some(error),
        }
    }
}

pub(super) fn validate(
    after: &EffectiveWorkerConfig,
    policy: &WorkerPoolPolicy,
    sessions: &BTreeMap<ProfileSessionId, ProfileEmployeeId>,
) -> Result<()> {
    let resources = ResourceConfiguration::capture(after.clone())
        .map_err(PoolConfigurationDataError::Resources)?;
    let memory = memory::validate(after).map_err(PoolConfigurationDataError::Memory)?;
    let projected = broker_resources::projection(after.as_value())
        .map_err(PoolConfigurationDataError::Resources)?;
    for (employee, template) in projected.employees() {
        let resource = template
            .resolve(projected.reservation_pool())
            .map_err(ResourceConfigError::from)
            .map_err(PoolConfigurationDataError::Resources)?;
        memory
            .project(Some(employee), Some(&resource))
            .map_err(DeviceConfigError::from)
            .map_err(PoolConfigurationDataError::Memory)?;
    }
    for (session, employee) in sessions {
        let high = policy
            .employee_memory_high_mi_b
            .get(employee.as_str())
            .ok_or(PoolConfigurationDataError::Refused(
                "WORKER_POOL_CONFIGURATION_UNAPPROVED_ROSTER",
            ))?;
        let resource = resources
            .project(session, Some(employee))
            .map_err(PoolConfigurationDataError::Resources)?;
        let effective = crate::resource_config::checked_effective_policy(&resource)
            .map_err(PoolConfigurationDataError::Resources)?;
        let effective = match memory::project_session(after, session, resource)
            .map_err(PoolConfigurationDataError::Memory)?
        {
            memory::SessionMemoryProjection::Frozen(value) => value.into_configuration(),
            memory::SessionMemoryProjection::Legacy(value) => {
                memory::project(&memory, value, Some(employee), Some(&effective))
                    .map_err(PoolConfigurationDataError::Memory)?
                    .into_configuration()
            }
        };
        let observed = ObservedMemoryPolicy::from_effective(&effective)
            .map_err(PoolConfigurationDataError::Engine)?;
        need(
            observed.is_some_and(|observed| {
                observed.uses_pool()
                    && observed.memory()
                        == &UnsignedInteger::from_u64(u64::from(policy.memory_max_mi_b) * 1_048_576)
                    && observed.swap().is_zero()
                    && observed.high()
                        == Some(&UnsignedInteger::from_u64(u64::from(*high) * 1_048_576))
            }),
            "WORKER_POOL_CONFIGURATION_EFFECTIVE_MEMORY",
        )?;
    }
    need(
        WorkerPoolProvider::from_config(after)
            .map_err(PoolConfigurationDataError::Policy)?
            .is_some_and(|provider| provider.policy() == policy),
        "WORKER_POOL_CONFIGURATION_PROVIDER",
    )
}
