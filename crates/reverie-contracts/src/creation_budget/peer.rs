use super::*;
use crate::legacy_json::{self, Number};
use reverie_core::decimal::UnsignedInteger;
/// Positive observed PID DATA only; no process lifetime or signal ownership.
pub struct PeerProcessId(UnsignedInteger);
impl PeerProcessId {
    pub fn decimal(&self) -> &str {
        self.0.as_str()
    }
}
pub struct CreationPeerInspection(Value);
pub struct OutsidePeerDeclarations<'a> {
    memory: &'a Value,
    total: &'a Value,
}
impl CreationPeerInspection {
    pub fn decode(stdout: &[u8]) -> Result<Self> {
        let mut value =
            legacy_json::decode_python_str(stdout).map_err(|_| CreationBudgetError::Json)?;
        let Node::Array(rows) = &mut value.0 else {
            return Err(CreationBudgetError::Inspection);
        };
        if rows.len() != 1 {
            return Err(CreationBudgetError::Inspection);
        }
        Ok(Self(rows.pop().expect("one row")))
    }
    pub fn running_identity(&self, deployment: &str, session: &ProfileSessionId) -> Result<bool> {
        let labels = field(field(&self.0, "Config")?, "Labels")?;
        let running = field(field(&self.0, "State")?, "Running")?;
        let Node::Bool(running) = running.0 else {
            return Err(CreationBudgetError::Ownership);
        };
        let labels = if legacy_json::truthy(Some(labels)) {
            Some(object(labels)?)
        } else {
            None
        };
        let matches = |name, wanted| matches!(labels.and_then(|labels|labels.get(&key(name))),Some(Value(Node::String(text))) if text.equals_ascii(wanted));
        if !matches("reverie.worker", deployment) || !matches("reverie.session", session.as_str()) {
            return Err(CreationBudgetError::Ownership);
        }
        Ok(running)
    }
    pub fn process(&self) -> Result<PeerProcessId> {
        unsigned(field(field(&self.0, "State")?, "Pid")?)
            .filter(|pid| !pid.is_zero())
            .map(PeerProcessId)
            .ok_or(CreationBudgetError::Pid)
    }
    pub fn outside_declarations(&self) -> Result<OutsidePeerDeclarations<'_>> {
        let host = field(&self.0, "HostConfig")?;
        let memory = field(host, "Memory")?;
        let total = field(host, "MemorySwap")?;
        Ok(OutsidePeerDeclarations { memory, total })
    }
    /// Source check_swap_budget runs this separate strict total check AFTER all
    /// peers have been inspected, including peers whose cgroup is in the pool.
    pub fn swap_commitment(&self) -> Result<UnsignedInteger> {
        let host = object(&self.0)?.get(&key("HostConfig"));
        let host = host.map(object).transpose()?;
        let value = |name| host.and_then(|host| host.get(&key(name)));
        let positive =
            |value: Option<&Value>| value.and_then(unsigned).filter(|value| !value.is_zero());
        let memory = positive(value("Memory")).ok_or(CreationBudgetError::SwapDeclarations)?;
        let total = value("MemorySwap")
            .and_then(unsigned)
            .ok_or(CreationBudgetError::SwapDeclarations)?;
        total
            .minus(&memory)
            .ok_or(CreationBudgetError::SwapDeclarations)
    }
}
impl OutsidePeerDeclarations<'_> {
    /// Acquire this view BEFORE the host resolves a peer's effective policy;
    /// source direct HostConfig key failures precede that native observation.
    pub fn assert_memory(&self, swap: Option<u64>) -> Result<UnsignedInteger> {
        // The effective projection's swap is a finite checked policy amount.
        // Python still attempts numeric addition before its strict RAM test.
        if swap.is_some() && !matches!(&self.memory.0, Node::Number(_) | Node::Bool(_)) {
            return Err(CreationBudgetError::Structure);
        }
        let memory = unsigned(self.memory)
            .filter(|value| !value.is_zero())
            .ok_or(CreationBudgetError::Outside)?;
        let expected = swap.map_or_else(
            || self.memory.deep_clone(),
            |swap| {
                Value(Node::Number(Number::Integer(
                    memory
                        .plus(&UnsignedInteger::from_u64(swap))
                        .as_str()
                        .to_owned(),
                )))
            },
        );
        if !self.total.python_eq(&expected) {
            return Err(CreationBudgetError::Outside);
        }
        Ok(memory)
    }
}
