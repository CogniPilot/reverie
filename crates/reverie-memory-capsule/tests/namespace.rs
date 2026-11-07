//! Explicit artifact qualification only; normal gates report this as ignored.
//! This creates no OCI/Created/Office/context or service-grant evidence.
#![cfg(target_os = "linux")]
#![forbid(unsafe_code)]
#[path = "support/namespace.rs"]
mod namespace;

#[test]
#[ignore = "requires an explicitly bound capsule and owned subordinate-ID namespace"]
fn actual_guest_capsule_namespace() {
    if std::env::var_os("REVERIE_CAPSULE_TEST_INNER").is_some() {
        namespace::inner();
    } else {
        namespace::outer();
    }
}
