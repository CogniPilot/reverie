//! Native initialization observations. These values are data, never a grant,
//! evidence of caller identity or permission to initialize a memory namespace.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryStartupPhase {
    Initializing,
    ProfilePending,
    Ready,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryReadinessError {
    UnknownPhase,
    ReadyWithoutModel,
    PendingWithModel,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryReadiness {
    phase: MemoryStartupPhase,
    model: Option<String>,
}
impl MemoryStartupPhase {
    pub fn parse(value: &str) -> Result<Self, MemoryReadinessError> {
        match value {
            "initializing" => Ok(Self::Initializing),
            "profile-pending" => Ok(Self::ProfilePending),
            "ready" => Ok(Self::Ready),
            _ => Err(MemoryReadinessError::UnknownPhase),
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Initializing => "initializing",
            Self::ProfilePending => "profile-pending",
            Self::Ready => "ready",
        }
    }
}
impl MemoryReadiness {
    pub fn try_new(
        phase: MemoryStartupPhase,
        model: Option<String>,
    ) -> Result<Self, MemoryReadinessError> {
        if phase == MemoryStartupPhase::Ready && model.is_none() {
            return Err(MemoryReadinessError::ReadyWithoutModel);
        }
        if phase != MemoryStartupPhase::Ready && model.is_some() {
            return Err(MemoryReadinessError::PendingWithModel);
        }
        // A selected embedder name has no new length/ASCII/nonempty bound.
        // SQLite TEXT supplies scalar encoding; the named row reader separately
        // checks the stored type instead of coercing BLOB/INTEGER values.
        Ok(Self { phase, model })
    }
    pub fn phase(&self) -> MemoryStartupPhase {
        self.phase
    }
    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }
    pub fn can_publish(&self, next: MemoryStartupPhase) -> bool {
        matches!(
            (self.phase, next),
            (
                MemoryStartupPhase::Initializing,
                MemoryStartupPhase::ProfilePending | MemoryStartupPhase::Ready
            ) | (
                MemoryStartupPhase::ProfilePending,
                MemoryStartupPhase::Ready
            )
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_phases_keep_missing_ready_model_distinct_from_pending() {
        for phase in [
            MemoryStartupPhase::Initializing,
            MemoryStartupPhase::ProfilePending,
            MemoryStartupPhase::Ready,
        ] {
            assert_eq!(MemoryStartupPhase::parse(phase.as_str()), Ok(phase));
        }
        assert_eq!(
            MemoryStartupPhase::parse("READY"),
            Err(MemoryReadinessError::UnknownPhase)
        );
        assert!(MemoryReadiness::try_new(MemoryStartupPhase::Initializing, None).is_ok());
        assert!(MemoryReadiness::try_new(MemoryStartupPhase::ProfilePending, None).is_ok());
        for phase in [
            MemoryStartupPhase::Initializing,
            MemoryStartupPhase::ProfilePending,
        ] {
            assert_eq!(
                MemoryReadiness::try_new(phase, Some("unexpected retained model".to_owned())),
                Err(MemoryReadinessError::PendingWithModel)
            );
        }
        assert_eq!(
            MemoryReadiness::try_new(MemoryStartupPhase::Ready, None),
            Err(MemoryReadinessError::ReadyWithoutModel)
        );
        for model in ["", "model\0Ω", " independent model / prefix "] {
            let value = MemoryReadiness::try_new(MemoryStartupPhase::Ready, Some(model.to_owned()))
                .unwrap();
            assert_eq!(value.model(), Some(model));
            assert!(!value.can_publish(MemoryStartupPhase::ProfilePending));
        }
        let pending = MemoryReadiness::try_new(MemoryStartupPhase::Initializing, None).unwrap();
        assert!(pending.can_publish(MemoryStartupPhase::ProfilePending));
        assert!(pending.can_publish(MemoryStartupPhase::Ready));
        assert!(!pending.can_publish(MemoryStartupPhase::Initializing));
    }
}
