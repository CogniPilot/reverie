//! RAM has a separate whole-failure join. Ambiguous claim or source attachment
//! never invokes the ordinary close-on-join-error path.
use super::*;
use crate::reservation_gate::EnteredRamDraft;
use crate::reservation_gate::RamDraftRetentionFailure;
use reverie_contracts::ram_migration::RamMigrationPolicy;
enum RamSourceCause {
    Source(SourceDraftError),
    Retention(Box<RamDraftRetentionFailure>),
    Restore {
        primary: Box<RamDraftRetentionFailure>,
        secondary: StorageWorkflowError,
    },
}
impl From<SourceDraftError> for RamSourceCause {
    fn from(cause: SourceDraftError) -> Self {
        Self::Source(cause)
    }
}
impl RamSourceDraftFailure {
    pub(in crate::installing_broker) fn code(&self) -> &'static str {
        match &self.cause {
            RamSourceCause::Source(cause) => cause.code(),
            RamSourceCause::Retention(failure) => failure.cause().code(),
            RamSourceCause::Restore { .. } => "RESOURCE_SOURCE_ATTACH_FINALIZATION",
        }
    }
}
impl std::fmt::Debug for RamSourceDraftFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut debug = f.debug_struct("RamSourceDraftFailure");
        debug
            .field("code", &self.code())
            .field(
                "claim",
                &self.claim.as_ref().map(RetainedPreparation::operation_id),
            )
            .field("source_retained", &self.source.is_some())
            .field(
                "policy",
                &self.policy.as_ref().map(RamMigrationPolicy::digest),
            );
        if let RamSourceCause::Restore { primary, secondary } = &self.cause {
            debug.field("primary", primary).field("cleanup", secondary);
        }
        debug.finish_non_exhaustive()
    }
}

pub(in crate::installing_broker) struct RamSourceDraftFailure {
    cause: RamSourceCause,
    pub(in crate::installing_broker) claim: Option<RetainedPreparation>,
    pub(in crate::installing_broker) source: Option<RegisteredSource>,
    policy: Option<RamMigrationPolicy>,
}
fn early(entry: EnteredRamDraft<'_>, cause: SourceDraftError) -> Box<RamSourceDraftFailure> {
    let cause = match entry.abort() {
        Ok(()) => cause,
        Err(error) => finalized(cause, error.into()),
    };
    Box::new(RamSourceDraftFailure {
        cause: cause.into(),
        claim: None,
        source: None,
        policy: None,
    })
}
impl InstallingBroker {
    pub(in crate::installing_broker) fn retain_ram_resource_draft(
        &self,
        entered: EnteredRamDraft<'_>,
    ) -> Result<(RetainedPreparation, RamMigrationPolicy), Box<RamSourceDraftFailure>> {
        if !entered.entry().installed_is(&self.installed) {
            return Err(early(
                entered,
                SourceDraftError::Refused("RESOURCE_PREPARATION_BROKER_CHANGED"),
            ));
        }
        let lifecycle = match self.installed.lifecycle() {
            Ok(value) => value,
            Err(error) => return Err(early(entered, error.into())),
        };
        let original = match original(
            &lifecycle,
            entered.entry().profile().binding().current_session(),
        ) {
            Ok(value) => value,
            Err(error) => return Err(early(entered, error)),
        };
        if original.storage.paths().identity()
            != entered.entry().profile().binding().employee().as_str()
        {
            return Err(early(
                entered,
                SourceDraftError::Refused("RESOURCE_ORIGINAL_SOURCE_CHANGED"),
            ));
        }
        let reference = match original.storage.original_source_reference() {
            Ok(value) => value,
            Err(error) => return Err(early(entered, error.into())),
        };
        let config = match self.configuration() {
            Ok(value) => value,
            Err(error) => return Err(early(entered, error.into())),
        };
        let attached = match reference.attach(
            config.configuration(),
            entered.entry().operation(),
            original.office.clone(),
        ) {
            Ok(value) => value,
            Err(error) => return Err(early(entered, error.into())),
        };
        let source = attached.retained_source();
        match entered.retain() {
            Err(failure) => {
                if failure.may_have_claimed() {
                    return Err(Box::new(RamSourceDraftFailure {
                        cause: RamSourceCause::Retention(failure),
                        claim: None,
                        source: Some(source),
                        policy: None,
                    }));
                }
                match attached.restore_unclaimed() {
                    Ok(()) => Err(Box::new(RamSourceDraftFailure {
                        cause: RamSourceCause::Retention(failure),
                        claim: None,
                        source: None,
                        policy: None,
                    })),
                    Err(error) => Err(Box::new(RamSourceDraftFailure {
                        cause: RamSourceCause::Restore {
                            primary: failure,
                            secondary: error,
                        },
                        claim: None,
                        source: Some(source),
                        policy: None,
                    })),
                }
            }
            Ok((claim, policy)) => match attached.join(claim) {
                Ok(claim) => Ok((claim, policy)),
                Err(failure) => {
                    let (claim, cause) = *failure;
                    Err(Box::new(RamSourceDraftFailure {
                        cause: RamSourceCause::Source(cause.into()),
                        claim: Some(claim),
                        source: Some(source),
                        policy: Some(policy),
                    }))
                }
            },
        }
    }
}
