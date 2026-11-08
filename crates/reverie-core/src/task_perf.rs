//! Owner-selected task perf policy data; neither a capability nor a start grant.
use crate::ids::ProfileEmployeeId;
use std::collections::BTreeMap;
use std::fmt;

pub const MAX_PERF_EMPLOYEES: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskPerfPolicy {
    TaskV1,
    TaskV2,
}
impl TaskPerfPolicy {
    pub fn name(self) -> &'static str {
        match self {
            Self::TaskV1 => "task-v1",
            Self::TaskV2 => "task-v2",
        }
    }
    pub fn from_name(value: &str) -> Option<Self> {
        match value {
            "task-v1" => Some(Self::TaskV1),
            "task-v2" => Some(Self::TaskV2),
            _ => None,
        }
    }
    pub fn rule(self) -> TaskPerfRule {
        TaskPerfRule { policy: self }
    }
}

/// Closed syscall argument filters. Kernel credentials and event permissions
/// remain independent; these data never grant CAP_PERFMON or SYS_ADMIN.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TaskPerfRule {
    policy: TaskPerfPolicy,
}
impl TaskPerfRule {
    pub fn syscall(self) -> &'static str {
        "perf_event_open"
    }
    pub fn action(self) -> &'static str {
        "SCMP_ACT_ALLOW"
    }
    pub fn arguments(self) -> &'static [TaskPerfArgument] {
        match self.policy {
            TaskPerfPolicy::TaskV1 => &[TaskPerfArgument {
                index: 2,
                mask: 0xffff_ffff,
                expected: 0xffff_ffff,
            }],
            TaskPerfPolicy::TaskV2 => &[
                // pid_t is signed 32-bit on the supported Linux ABIs.
                // Ignore unused upper PID register bits, reject every negative
                // PID, including system-wide pid=-1.
                TaskPerfArgument {
                    index: 1,
                    mask: 0x8000_0000,
                    expected: 0,
                },
                // Allow only FD_NO_GROUP, FD_OUTPUT and FD_CLOEXEC. In
                // particular PID_CGROUP (bit2) and all future flags refuse.
                // Noncanonical upper compat flag bits conservatively refuse.
                TaskPerfArgument {
                    index: 4,
                    mask: !0x0b,
                    expected: 0,
                },
            ],
        }
    }
    pub fn matches_arguments(self, arguments: &[u64; 5]) -> bool {
        self.arguments()
            .iter()
            .all(|filter| arguments[usize::from(filter.index)] & filter.mask == filter.expected)
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TaskPerfArgument {
    index: u8,
    mask: u64,
    expected: u64,
}
impl TaskPerfArgument {
    pub fn index(self) -> u8 {
        self.index
    }
    pub fn mask(self) -> u64 {
        self.mask
    }
    pub fn expected(self) -> u64 {
        self.expected
    }
    pub fn operator(self) -> &'static str {
        "SCMP_CMP_MASKED_EQ"
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
        assert_eq!(rule.arguments()[0].index(), 2);
        for cpu in [0xffff_ffff, u64::MAX, 0x1234_5678_ffff_ffff] {
            assert!(rule.matches_arguments(&[0, 1, cpu, u64::MAX, 0]));
        }
        for cpu in [
            0,
            1,
            0x7fff_ffff,
            0xffff_fffe,
            0x1_0000_0000,
            0xffff_ffff_0000_0001,
        ] {
            assert!(!rule.matches_arguments(&[0, 1, cpu, u64::MAX, 0]));
        }
    }
    #[test]
    fn v2_requires_one_nonnegative_pid_and_only_closed_flags_across_abi_spellings() {
        let rule = TaskPerfPolicy::TaskV2.rule();
        let pids = [
            (0, true),
            (1, true),
            (0x7fff_ffff, true),
            (0xffff_ffff_0000_0001, true),
            (0x8000_0000_0000_0000, true),
            (0x8000_0000, false),
            (0xffff_ffff, false),
            (u64::MAX, false),
            (u64::MAX - 1, false),
        ];
        let flags = [
            (0, true),
            (1, true),
            (2, true),
            (3, true),
            (8, true),
            (9, true),
            (10, true),
            (11, true),
            (4, false),
            (5, false),
            (12, false),
            (15, false),
            (16, false),
            (1 << 32, false),
            (u64::MAX, false),
        ];
        for (pid, valid_pid) in pids {
            for (flags, valid_flags) in flags {
                check_cpu_spellings(rule, pid, flags, valid_pid && valid_flags);
            }
        }
    }
    fn check_cpu_spellings(rule: TaskPerfRule, pid: u64, flags: u64, expected: bool) {
        for cpu in [0, 7, 0xffff_ffff, u64::MAX, 0x8000_0000] {
            assert_eq!(
                rule.matches_arguments(&[0, pid, cpu, u64::MAX, flags]),
                expected,
                "pid={pid:x} cpu={cpu:x} flags={flags:x}"
            );
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
