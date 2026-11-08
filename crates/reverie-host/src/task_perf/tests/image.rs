//! Explicit rootless image acceptance, never selected by the normal suite.
//! All effects are owned fixture containers; there is no employee operation.
use crate::test_docker as docker;
mod guest;
mod inputs;
mod parent;
mod rootfs;

const CASE: &str = "task_perf::tests::image::actual_rootless_task_v1_perf";
const CASE_V2: &str = "task_perf::tests::image::actual_rootless_task_v2_perf";
const WORKLOAD: &str = "task_perf::tests::image::fixed_native_perf_workload";

#[test]
#[ignore = "requires reviewed rootless image/provenance/profile/native closure fixture; no host setup"]
fn actual_rootless_task_v1_perf() {
    run(reverie_core::task_perf::TaskPerfPolicy::TaskV1);
}
#[test]
#[ignore = "requires separately reviewed task-v2 artifact; actual owned Docker/perf only"]
fn actual_rootless_task_v2_perf() {
    run(reverie_core::task_perf::TaskPerfPolicy::TaskV2);
}
fn run(policy: reverie_core::task_perf::TaskPerfPolicy) {
    if std::env::var_os("REVERIE_TASK_PERF_GUEST").as_deref() == Some(std::ffi::OsStr::new("1")) {
        guest::run(policy);
    } else {
        parent::run(policy);
    }
}
fn case(policy: reverie_core::task_perf::TaskPerfPolicy) -> &'static str {
    match policy {
        reverie_core::task_perf::TaskPerfPolicy::TaskV1 => CASE,
        reverie_core::task_perf::TaskPerfPolicy::TaskV2 => CASE_V2,
    }
}

#[test]
#[ignore = "fixed subprocess workload only; invoked by the reviewed perf guest"]
fn fixed_native_perf_workload() {
    assert_eq!(std::env::var("REVERIE_TASK_PERF_GUEST").as_deref(), Ok("1"));
    assert!(nix::unistd::geteuid().as_raw() > 0);
    let until = std::time::Instant::now() + std::time::Duration::from_millis(750);
    let mut value = 1_u64;
    while std::time::Instant::now() < until {
        for n in 1..10_000_u64 {
            value = std::hint::black_box(value.wrapping_add(n).wrapping_mul(n));
        }
    }
    println!("NATIVE_WORKLOAD {value}");
}
