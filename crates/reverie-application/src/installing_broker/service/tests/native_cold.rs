//! One curated real Docker/R Cold-J acceptance case. Default CI never executes
//! this module's effects. Inputs and the exact ignored selector need review.
use super::*;
use reverie_contracts::{resource_actor::ArtifactReference, worker_image_switch::WorkerImageId};
use reverie_core::{
    ids::ProfileSessionId,
    worker_wire::{HEADER_BYTES, WorkerFrameHeader},
};
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
};
mod engine;
mod tenant;
mod transaction;
use engine::Cli;
use tenant::{Inputs, Tenant};
type Result<T> = std::result::Result<T, String>;

#[test]
#[ignore = "real qualified image + private synthetic server/company + R; requires independent fixture/effect review"]
fn actual_qualified_native_image_cold_j_through_service_releases_r_and_stops_same_owner() {
    let inputs = Inputs::capture().expect("closed reviewed fixture inputs");
    let mut attempt = transaction::Attempt::new(inputs).expect("fresh private tenant");
    let body = attempt.run();
    let closed = attempt.cleanup();
    // Preserve the original root and every unknown owner before verdict. There
    // is no blanket rm, image removal, production path or auto-retry.
    if let Err(error) = &body {
        eprintln!(
            "COLD_J_BODY_RETAINED root={:?}: {error}",
            attempt.tenant.root
        );
    }
    if let Err(error) = &closed {
        eprintln!(
            "COLD_J_CLEANUP_RETAINED root={:?}: {error}",
            attempt.tenant.root
        );
    }
    body.expect("actual R-enabled native Cold J and bare-record compatibility");
    closed.expect("same-original worker/service/server owners must close");
}
