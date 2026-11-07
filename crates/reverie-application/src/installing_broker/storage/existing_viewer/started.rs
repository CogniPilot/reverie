//! Move a real later-J Started claim into the SAME Host inventory slot, then
//! publish the same-Arc Existing handle under the original registry guard.
use super::*;
use crate::installing_broker::storage::started::StartedClaim;
use reverie_host::{office::OfficePhone, worker_reports::WorkerLaunchConnection};

pub(super) fn retain(
    owner: Box<StartedClaim>,
    inputs: Inputs,
    connection: &WorkerLaunchConnection,
) -> Result<ExistingStoragePreparation, Box<ExistingStorageRetainFailure>> {
    let mut inputs = Some(inputs);
    match transfer(&owner, &mut inputs, connection) {
        Ok((viewer, office)) => Ok(ExistingStoragePreparation {
            destination: owner.destination,
            viewer,
            predecessor_office: Some(office),
        }),
        Err(error) => Err(Box::new(ExistingStorageRetainFailure {
            claim: StorageClaim {
                state: ClaimState::Started(owner),
            },
            inputs: inputs.expect("every refusal returns all original observations"),
            error,
        })),
    }
}
fn transfer(
    owner: &StartedClaim,
    inputs: &mut Option<Inputs>,
    connection: &WorkerLaunchConnection,
) -> Result<(Arc<ExistingViewer>, OfficePhone), ExistingStorageError> {
    if !std::ptr::eq(owner.connection.as_ref(), connection) {
        return Err(ExistingStorageError::Refused(
            "WORKER_STARTED_CONNECTION_CHANGED",
        ));
    }
    let registry = owner.destination.registry();
    let mut entries = match &owner.destination {
        Destination::Legacy { .. } => None,
        Destination::Registered { .. } => Some(registry.lock(registry.runtime.stop_deadline())?),
    };
    let index = match (&owner.destination, &entries) {
        (Destination::Registered { identity, .. }, Some(entries)) => {
            let index = selected(entries, identity)?;
            if !entries[index].writer_checked
                || entries[index].paths != owner.paths
                || !matches!(&entries[index].owner, EntryOwner::Laptop(actual) if owner.owner.created.same_workflow(actual))
            {
                return Err(ExistingStorageError::Refused(
                    "WORKER_STARTED_STORAGE_CHANGED",
                ));
            }
            Some(index)
        }
        (Destination::Legacy { .. }, None) => None,
        _ => unreachable!("same checked original destination"),
    };
    let Inputs {
        plan,
        inspected,
        receipt,
        request,
    } = inputs.take().expect("actual original inputs");
    let transferred = match registry.runtime.transfer_started_laptop_relay(
        &owner.owner.created,
        plan,
        inspected,
        receipt,
        connection,
    ) {
        Ok(transferred) => transferred,
        Err(failure) => {
            let (plan, inspected, receipt, cause) = failure.into_parts();
            *inputs = Some(Inputs {
                plan,
                inspected,
                receipt,
                request,
            });
            return Err(cause.into());
        }
    };
    let (viewer, office, _original_request_data) = transferred.into_parts();
    let viewer = Arc::new(viewer);
    if let (Some(entries), Some(index)) = (&mut entries, index) {
        entries[index].owner = EntryOwner::Existing(viewer.clone());
    }
    Ok((viewer, office))
}
