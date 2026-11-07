//! Raw guard then fresh effective/image qualification precede the only unlock.
use super::*;
use reverie_contracts::{
    worker_cold_tmp::{ColdConfiguration, ColdStrategy},
    worker_config,
};
use reverie_host::worker_nix::{NixImageQualification, NixProgress};
impl ColdBody<'_> {
    pub(super) fn copy_nix(&mut self) -> Result<(), ColdError> {
        self.enter_nix()?;
        let Resources::CopyingNix(input) = self.resources.as_ref().expect("same Nix slot") else {
            unreachable!()
        };
        match input.preparation.qualify_rootless_image(self.end())? {
            NixImageQualification::Confirmed | NixImageQualification::NotRequired => {}
            NixImageQualification::Rejected | NixImageQualification::Retained => {
                return Err(ColdError::Refused("WORKER_COLD_IMAGE_UNCONFIRMED"));
            }
        }
        drop(self.lifecycle.take());
        let copied = input.preparation.run();
        // Like source finally, reacquire even when the SAME copy call failed.
        // Poison/refused mutex acquisition retains all actual Nix/J owners.
        let locked = self.broker().installed.lifecycle();
        match locked {
            Ok(lifecycle) => self.lifecycle = Some(lifecycle),
            Err(secondary) => {
                return Err(match copied {
                    Ok(_) => secondary.into(),
                    Err(primary) => error::finalized(primary.into(), secondary.into()),
                });
            }
        }
        match copied? {
            NixProgress::NoHelper | NixProgress::Prepared => {}
            NixProgress::Rejected | NixProgress::Retained => {
                return Err(ColdError::Refused("WORKER_COLD_NIX_UNCONFIRMED"));
            }
        }
        self.after_copy()?;
        let Resources::CopyingNix(input) = self.resources.as_mut().expect("same Nix slot") else {
            unreachable!()
        };
        if let Some(removal) = &mut input.removal {
            input.preparation.remove_old_laptop(&input.plan, removal)?;
        }
        let policy = ColdConfiguration::capture(input.plan.source())
            .map_err(reverie_host::worker_storage::StorageOwnerError::ColdData)
            .map_err(StorageWorkflowError::from)?;
        if policy
            .as_ref()
            .is_some_and(|policy| policy.strategy() == ColdStrategy::RetainAndReplace)
        {
            let end = Instant::now() + std::time::Duration::from_secs(30);
            input
                .preparation
                .prepare_retained_temporary(&input.plan, end)?;
        }
        Ok(())
    }
    fn enter_nix(&mut self) -> Result<(), ColdError> {
        let source = self.broker().configuration()?;
        let Resources::Stopped(input) = self.resources.as_mut().expect("post-stop actual storage")
        else {
            unreachable!()
        };
        input.storage.record_storage_binding()?;
        let guard = NixStoreGuard::acquire_launch(source.configuration(), input.plan.session())
            .map_err(storage::NixStorageError::from)?;
        let Resources::Stopped(stopped) = self.resources.take().expect("same actual resources")
        else {
            unreachable!()
        };
        self.resources = Some(Resources::PreparingNix(PreparingNix { stopped, guard }));
        // Effective configuration is intentionally read AFTER raw guard acquisition.
        let Resources::PreparingNix(input) =
            self.resources.as_ref().expect("held original raw guard")
        else {
            unreachable!()
        };
        let prepared = crate::resource_staging::effective_config(
            source.configuration().clone(),
            input.stopped.plan.session(),
        )
        .map_err(PreparationError::from)?;
        let Resources::PreparingNix(input) = self.resources.take().expect("same raw guard") else {
            unreachable!()
        };
        let PreparingNix { stopped, guard } = input;
        let Stopped {
            storage,
            plan,
            removal,
        } = stopped;
        match storage.retain_nix(guard, prepared.clone()) {
            Ok(preparation) => {
                self.resources = Some(Resources::CopyingNix(CopyingNix {
                    preparation,
                    plan,
                    prepared,
                    removal,
                }));
                Ok(())
            }
            Err(failure) => {
                let (storage, guard, cause) = failure.into_parts();
                self.resources = Some(Resources::PreparingNix(PreparingNix {
                    stopped: Stopped {
                        storage,
                        plan,
                        removal,
                    },
                    guard,
                }));
                Err(cause.into())
            }
        }
    }
    fn after_copy(&self) -> Result<(), ColdError> {
        self.lifecycle()
            .check_generation(&self.scope.observed.generation)?;
        self.scope.preparing.assert_allowed()?;
        self.lifecycle().reenter_active(
            self.scope.active.as_ref().expect("original active token"),
            &self.scope.preparing.admitted,
        )?;
        let Resources::CopyingNix(input) = self.resources.as_ref().expect("same copied slot")
        else {
            unreachable!()
        };
        let current = crate::resource_staging::effective_config(
            self.broker().configuration()?.configuration().clone(),
            input.plan.session(),
        )
        .map_err(PreparationError::from)?;
        if !worker_config::equivalent(&current, &input.prepared) {
            return Err(ColdError::Refused(
                "Laptop policy changed during Nix preparation; retry with the current policy",
            ));
        }
        input.preparation.recheck_after_copy()?;
        self.broker()
            .check_creation_budget_locked(
                self.lifecycle(),
                input.plan.session(),
                &input.prepared,
                self.scope.preparing.admitted.admission.as_ref(),
            )
            .map_err(PreparationError::from)
            .map_err(Into::into)
    }
}
