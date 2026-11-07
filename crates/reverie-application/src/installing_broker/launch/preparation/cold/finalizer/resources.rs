//! Return only actual known originals, then close the actual guard before the
//! source receipt predicate. Unknown records keep their counted resource owner.
use super::*;
impl Finalizer<'_> {
    pub(super) fn close_guard(&mut self) {
        if let Some(network) = self.owner.network() {
            if self.owner.created().is_some() {
                if let Err(error) = network
                    .cleanup_nix_guard(&self.owner.scope().preparing.admitted.request.connection)
                {
                    self.errors.push(error.into());
                }
                return;
            }
        }
        let Owner::Body(owner) = &mut self.owner else {
            return;
        };
        let Some(resources) = owner.resources.take() else {
            return;
        };
        owner.resources = Some(match resources {
            Resources::PreparingNix(input) => Resources::Returned(ReturnedStorage {
                storage: input.stopped.storage,
                plan: input.stopped.plan,
                guard: Some(input.guard),
                phone: None,
            }),
            Resources::CopyingNix(input) => {
                self_return_nix(input, &mut self.errors, &mut self.body_causes)
            }
            Resources::NetworkHeld(network) => {
                match network.abort_held_network(&owner.scope.preparing.admitted.request.connection)
                {
                    Ok((nix, plan, _request, phone)) => {
                        returned(nix, plan, Some(phone), &mut self.body_causes)
                    }
                    Err(error) => {
                        self.errors.push(error.into());
                        Resources::NetworkHeld(network)
                    }
                }
            }
            Resources::Network(network) => match Arc::try_unwrap(network) {
                Ok(network) => match network.reclaim() {
                    Ok(restored) => {
                        let (nix, plan, _request, phone, outcome) = restored.into_parts();
                        if let Err(error) = outcome {
                            self.body_causes.push(ColdError::Recorded(error));
                        }
                        returned(nix, plan, Some(phone), &mut self.body_causes)
                    }
                    Err(failure) => {
                        let (network, error) = failure.into_parts();
                        self.errors.push(error.into());
                        Resources::Network(Arc::new(network))
                    }
                },
                Err(network) => {
                    self.errors
                        .push(ColdError::Refused("WORKER_COLD_NETWORK_STILL_SHARED"));
                    Resources::Network(network)
                }
            },
            other => other,
        });
        if let Some(Resources::Returned(input)) = &mut owner.resources
            && let Some(guard) = input.guard.take()
            && let Err(error) = guard.close()
        {
            self.errors
                .push(storage::NixStorageError::from(error).into());
        }
        // A failed create/network result may remain uncertain without minting
        // Created. Its known-success Nix guard still has a real cleanup owner;
        // keep the actual Box/pending native outcome counted after local close.
        if let Some(Resources::Network(network) | Resources::NetworkHeld(network)) =
            &owner.resources
            && let Err(error) =
                network.cleanup_nix_guard(&owner.scope.preparing.admitted.request.connection)
        {
            self.errors.push(error.into());
        }
    }
}
fn self_return_nix(
    input: CopyingNix,
    errors: &mut Vec<ColdError>,
    causes: &mut Vec<ColdError>,
) -> Resources {
    let CopyingNix {
        preparation,
        plan,
        prepared,
        removal,
    } = input;
    match preparation.reclaim() {
        Ok(nix) => returned(nix, plan, None, causes),
        Err(failure) => {
            let (preparation, error) = failure.into_parts();
            errors.push(error.into());
            Resources::CopyingNix(CopyingNix {
                preparation,
                plan,
                prepared,
                removal,
            })
        }
    }
}
fn returned(
    nix: storage::NixStorageReturned,
    plan: ObservedCreatePlan,
    phone: Option<reverie_host::office::OfficePhone>,
    causes: &mut Vec<ColdError>,
) -> Resources {
    let (storage, guard, outcome) = nix.into_parts();
    if let Err(error) = outcome {
        causes.push(storage::NixStorageError::from(error).into());
    }
    Resources::Returned(ReturnedStorage {
        storage,
        plan,
        guard: Some(guard),
        phone,
    })
}
