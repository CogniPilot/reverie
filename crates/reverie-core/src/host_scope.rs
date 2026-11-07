//! Fixed host-job declarations. These values are DATA, never an owned systemd
//! invocation, observed process identity, settlement or execution permission.
use crate::decimal::UnsignedInteger;
use std::{collections::BTreeSet, fmt};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostScopeError {
    JobId,
    FiniteSpec,
    CpuSpec,
}
impl HostScopeError {
    pub fn code(self) -> &'static str {
        match self {
            Self::JobId => "JOB_ID",
            Self::FiniteSpec => "FINITE_SCOPE_SPEC",
            Self::CpuSpec => "PRIVATE_CPU_SPEC",
        }
    }
}
impl fmt::Display for HostScopeError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for HostScopeError {}
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct HostJobId(String);
impl HostJobId {
    /// Source regex admits every32-character lowercase hex string, including
    /// zero. This namespace is separate from nonnil journal UUID roles.
    pub fn parse(text: &str) -> Result<Self, HostScopeError> {
        if text.len() != 32
            || !text
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(HostScopeError::JobId);
        }
        Ok(Self(text.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn unit(&self) -> String {
        format!("reverie-gpu-job-{}.scope", self.0)
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostScopeLimits {
    memory: u64,
    pids: u32,
    runtime: u32,
    stop: u32,
    cpus: Vec<UnsignedInteger>,
}
impl HostScopeLimits {
    pub fn try_new(
        memory: u64,
        pids: u32,
        runtime: u32,
        stop: u32,
        cpus: Vec<UnsignedInteger>,
    ) -> Result<Self, HostScopeError> {
        Self::validate_counters(memory, pids, runtime, stop)?;
        if !(1..=8).contains(&cpus.len())
            || cpus.iter().collect::<BTreeSet<_>>().len() != cpus.len()
        {
            return Err(HostScopeError::CpuSpec);
        }
        Ok(Self {
            memory,
            pids,
            runtime,
            stop,
            cpus,
        })
    }
    /// The decoder checks the original counter phase before inspecting CPU
    /// element types; construction uses the same predicate without duplication.
    pub fn validate_counters(
        memory: u64,
        pids: u32,
        runtime: u32,
        stop: u32,
    ) -> Result<(), HostScopeError> {
        if memory == 0
            || memory > 16 * 1024 * 1024 * 1024
            || pids == 0
            || pids > 512
            || runtime == 0
            || runtime > 3600
            || stop == 0
            || stop > 60
        {
            return Err(HostScopeError::FiniteSpec);
        }
        Ok(())
    }
    pub fn memory_bytes(&self) -> u64 {
        self.memory
    }
    pub fn pids(&self) -> u32 {
        self.pids
    }
    pub fn runtime_seconds(&self) -> u32 {
        self.runtime
    }
    pub fn stop_seconds(&self) -> u32 {
        self.stop
    }
    /// Original nonnegative Python integer declarations have no artificial
    /// machine-word/physical-CPU bound. Native qualification is separate.
    pub fn cpus(&self) -> &[UnsignedInteger] {
        &self.cpus
    }
}
