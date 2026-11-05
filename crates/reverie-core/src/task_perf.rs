//! Owner-selected task perf policy data; neither a capability nor a start grant.
use crate::ids::ProfileEmployeeId;
use std::collections::BTreeMap;
use std::fmt;

pub const MAX_PERF_EMPLOYEES: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskPerfPolicy {
    TaskV1,
}
impl TaskPerfPolicy {
    pub fn name(self) -> &'static str {
        match self {
            Self::TaskV1 => "task-v1",
        }
    }
    pub fn rule(self) -> TaskPerfRule {
        TaskPerfRule { _private: () }
    }
}

/// Exactly the signed-int CPU=-1 filter. Kernel credentials and perf permission
/// checks remain independent; this data never grants CAP_PERFMON or SYS_ADMIN.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TaskPerfRule {
    _private: (),
}
impl TaskPerfRule {
    pub fn syscall(self) -> &'static str {
        "perf_event_open"
    }
    pub fn action(self) -> &'static str {
        "SCMP_ACT_ALLOW"
    }
    pub fn argument_index(self) -> u8 {
        2
    }
    pub fn mask(self) -> u64 {
        0xffff_ffff
    }
    pub fn expected(self) -> u64 {
        0xffff_ffff
    }
    pub fn operator(self) -> &'static str {
        "SCMP_CMP_MASKED_EQ"
    }
    pub fn matches_argument(self, value: u64) -> bool {
        value & self.mask() == self.expected()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskPerfPolicyError {
    EmployeeCount,
    RootlessDockerRequired,
}
impl TaskPerfPolicyError {
    pub fn code(self) -> &'static str {
        match self {
            Self::EmployeeCount => "TASK_PERF_EMPLOYEE_COUNT",
            Self::RootlessDockerRequired => "TASK_PERF_ROOTLESS_DOCKER_REQUIRED",
        }
    }
}
impl fmt::Display for TaskPerfPolicyError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for TaskPerfPolicyError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskPerfPolicies(BTreeMap<ProfileEmployeeId, TaskPerfPolicy>);
impl TaskPerfPolicies {
    /// The configuration adapter must supply whether rootlessDocker.enabled is
    /// the literal boolean true. An empty map does not require Docker policy.
    pub fn try_new(
        policies: BTreeMap<ProfileEmployeeId, TaskPerfPolicy>,
        rootless_enabled: bool,
    ) -> Result<Self, TaskPerfPolicyError> {
        if policies.len() > MAX_PERF_EMPLOYEES {
            return Err(TaskPerfPolicyError::EmployeeCount);
        }
        if !policies.is_empty() && !rootless_enabled {
            return Err(TaskPerfPolicyError::RootlessDockerRequired);
        }
        Ok(Self(policies))
    }
    pub fn entries(&self) -> &BTreeMap<ProfileEmployeeId, TaskPerfPolicy> {
        &self.0
    }
    /// Selection uses observed current identity only. OFF/vacation/start gates
    /// are separate; this lookup grants no execution or owner permission.
    pub fn selected(&self, employee: Option<&ProfileEmployeeId>) -> Option<TaskPerfPolicy> {
        employee.and_then(|employee| self.0.get(employee).copied())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn employee(number: usize) -> ProfileEmployeeId {
        ProfileEmployeeId::parse(&format!("{number:08x}-0000-0000-0000-000000000000")).unwrap()
    }
    #[test]
    fn fixed_rule_recognizes_only_signed_int_minus_one_cpu() {
        let rule = TaskPerfPolicy::TaskV1.rule();
        assert_eq!(rule.argument_index(), 2);
        for cpu in [0xffff_ffff, u64::MAX, 0x1234_5678_ffff_ffff] {
            assert!(rule.matches_argument(cpu));
        }
        for cpu in [
            0,
            1,
            0x7fff_ffff,
            0xffff_fffe,
            0x1_0000_0000,
            0xffff_ffff_0000_0001,
        ] {
            assert!(!rule.matches_argument(cpu));
        }
    }
    #[test]
    fn bounded_selection_requires_rootless_without_inventing_a_default() {
        let entries = BTreeMap::from([(employee(1), TaskPerfPolicy::TaskV1)]);
        assert_eq!(
            TaskPerfPolicies::try_new(entries.clone(), false),
            Err(TaskPerfPolicyError::RootlessDockerRequired)
        );
        let policies = TaskPerfPolicies::try_new(entries, true).unwrap();
        assert_eq!(
            policies.selected(Some(&employee(1))),
            Some(TaskPerfPolicy::TaskV1)
        );
        assert_eq!(policies.selected(Some(&employee(2))), None);
        assert_eq!(policies.selected(None), None);
        assert!(TaskPerfPolicies::try_new(BTreeMap::new(), false).is_ok());
        let entries = (0..256)
            .map(|id| (employee(id), TaskPerfPolicy::TaskV1))
            .collect();
        assert!(TaskPerfPolicies::try_new(entries, true).is_ok());
        let entries = (0..257)
            .map(|id| (employee(id), TaskPerfPolicy::TaskV1))
            .collect();
        assert_eq!(
            TaskPerfPolicies::try_new(entries, true),
            Err(TaskPerfPolicyError::EmployeeCount)
        );
    }
}
