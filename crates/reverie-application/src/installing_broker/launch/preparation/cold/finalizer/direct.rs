//! One-shot actual Direct observation and physical finish. Unknown Nix,
//! network, Created and native-stop owners are never converted into Direct.
use super::*;
use reverie_host::worker_laptop::DirectStorageObservation;

impl Finalizer<'_> {
    fn observe_direct_storage(&mut self) -> Option<DirectStorageObservation> {
        let slot = self.owner.resource_slot()?;
        let Some(resources) = slot.take() else {
            return None;
        };
        let input = match resources {
            Resources::OriginalCleanup {
                storage,
                plan,
                inspection,
            } => Some((storage, plan, FinalStorageRemainder::Original(inspection))),
            Resources::Direct(input) => Some((
                input.storage,
                input.plan,
                FinalStorageRemainder::Direct(input.target),
            )),
            Resources::Stopped(input) => Some((
                input.storage,
                input.plan,
                FinalStorageRemainder::Stopped(input.removal),
            )),
            Resources::Returned(input) if input.guard.is_none() => Some((
                input.storage,
                input.plan,
                FinalStorageRemainder::Returned(input.phone),
            )),
            other => {
                *slot = Some(other);
                None
            }
        };
        let Some((claim, plan, remainder)) = input else {
            return None;
        };
        match claim.retain_direct_final_storage(plan) {
            Ok(native) => *slot = Some(Resources::FinalStorage(FinalStorage { native, remainder })),
            Err(failure) => {
                let (claim, plan, cause) = failure.into_parts();
                *slot = Some(remainder.restore(claim, plan));
                self.errors.push(cause.into());
                return None;
            }
        }
        let Some(Resources::FinalStorage(input)) = slot else {
            unreachable!("actual preparation just published");
        };
        match input.native.observe() {
            Ok(observation) => Some(observation),
            Err(cause) => {
                self.errors.push(cause.into());
                None
            }
        }
    }

    fn finish_direct_storage(
        &mut self,
        observation: &DirectStorageObservation,
        end: Instant,
    ) -> Option<bool> {
        let slot = self.owner.resource_slot()?;
        let Some(Resources::FinalStorage(input)) = slot.take() else {
            unreachable!("same actual observation requires its retained preparation");
        };
        let FinalStorage { native, remainder } = input;
        match native.finish(observation, end) {
            Ok(finished) => {
                let (plan, retained) = finished.into_parts();
                *slot = Some(Resources::Finalized {
                    plan,
                    retained,
                    remainder,
                });
                Some(retained)
            }
            Err(failure) => {
                // Keep the actual opaque native/physical failure owner. Never
                // rebuild a claim or ask a later observation to forgive it.
                *slot = Some(Resources::FinalStorageFailed { failure, remainder });
                self.errors
                    .push(ColdError::Refused("WORKER_COLD_FINAL_STORAGE_RETAINED"));
                None
            }
        }
    }
}

impl FinalStorageRemainder {
    fn restore(self, storage: StorageClaim, plan: ObservedCreatePlan) -> Resources {
        match self {
            Self::Original(inspection) => Resources::OriginalCleanup {
                storage,
                plan,
                inspection,
            },
            Self::Direct(target) => Resources::Direct(Direct {
                storage,
                plan,
                target,
            }),
            Self::Stopped(removal) => Resources::Stopped(Stopped {
                storage,
                plan,
                removal,
            }),
            Self::Returned(phone) => Resources::Returned(ReturnedStorage {
                storage,
                plan,
                guard: None,
                phone,
            }),
        }
    }
}
