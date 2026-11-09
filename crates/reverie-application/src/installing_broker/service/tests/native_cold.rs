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
mod generation;
mod tenant;
mod transaction;
use engine::Cli;
use tenant::{Inputs, Tenant};
type Result<T> = std::result::Result<T, String>;

#[test]
#[ignore = "real qualified image + private synthetic server/company + R; requires independent fixture/effect review"]
fn actual_qualified_native_image_cold_j_through_service_releases_r_and_stops_same_owner() {
    run_case(Case::Cold);
}

#[test]
#[ignore = "real qualified image + private synthetic tenant + two viewer EOFs; requires independent exact effect review"]
fn actual_native_viewer_eof_reconnect_preserves_same_live_provider_and_command() {
    run_case(Case::ViewerReconnect);
}
#[derive(Clone, Copy)]
enum Case {
    Cold,
    ViewerReconnect,
}
fn run_case(case: Case) {
    let inputs = Inputs::capture().expect("closed reviewed fixture inputs");
    let mut attempt = transaction::Attempt::new(inputs).expect("fresh private tenant");
    let body = match case {
        Case::Cold => attempt.run(),
        Case::ViewerReconnect => attempt.run_reconnect(),
    };
    if body.is_err()
        && matches!(case, Case::ViewerReconnect)
        && let Err(error) = attempt.preserve_reconnect_diagnostics()
    {
        eprintln!("RECONNECT_DIAGNOSTICS_RETAINED: {error}");
    }
    if body.is_err()
        && let Err(error) = attempt.preserve_create_diagnostics()
    {
        eprintln!(
            "COLD_J_DIAGNOSTICS_RETAINED root={:?}: {error}",
            attempt.tenant.root
        );
    }
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
    if matches!(case, Case::ViewerReconnect) {
        println!(
            "REAL_NATIVE_VIEWER_RECONNECT_OK coldEOF=joined reuseEOF=joined providerCID+birth=unchanged controller+command=unchanged publication=unchanged exit=0 service=closed"
        );
    }
}
