//! Actual isolated library-owner process replacement, not the NSS service CLI.
use super::*;

#[test]
#[ignore = "real two-worker Docker/R process-generation canary; independent exact once-case approval required"]
fn actual_broker_generation_preserves_live_sibling_and_releases_retired_session() {
    transaction::generation::run().expect("original generation and untouched sibling continuity");
}

#[test]
#[ignore = "private child role of the exact generation canary; never a standalone product command"]
fn native_broker_generation_actor() {
    transaction::generation::actor().expect("same private original actor scope");
}
