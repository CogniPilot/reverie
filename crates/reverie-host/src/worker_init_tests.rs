//! Init-only owned Docker controls; never a launch/pool/perf-consumer proof.
use crate::test_docker as docker;
mod fixture;
mod inputs;
mod probe;
mod transport;

const INIT: &str = "/opt/reverie/perf/bin/reverie-worker-init";
const PROBE: &str = "/run/reverie-init-tests.elf";
const PARENT: &str = "worker_init_tests::orphan_parent";
const CHILD: &str = "worker_init_tests::orphan_child";
const OBSERVER: &str = "worker_init_tests::orphan_observer";

#[test]
#[ignore = "requires frozen static-init Nix capsule and owned Docker PREEXEC; no company effects"]
fn actual_static_pid1_adopts_reaps_and_handles_term_int() {
    let inputs = inputs::Inputs::capture();
    for signal in ["TERM", "INT"] {
        fixture::run(&inputs, signal);
    }
}

#[test]
#[ignore = "fixed in-container orphan parent only; namespace guard before process exit"]
fn orphan_parent() {
    transport::parent();
}
#[test]
#[ignore = "fixed contained orphan workload only; no arbitrary command"]
fn orphan_child() {
    let scope = transport::Scope::capture(transport::Phase::Child);
    probe::child(&scope);
}
#[test]
#[ignore = "fixed in-container adoption/reaping observer only"]
fn orphan_observer() {
    transport::observer();
}
