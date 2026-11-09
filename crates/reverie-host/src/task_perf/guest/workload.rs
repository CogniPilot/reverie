use super::error::{Result, need};
use reverie_contracts::task_perf_check::CHECKER;
use std::time::{Duration, Instant};

/// Fixed two-thread user-space work only. No program, duration or path selector.
pub fn run() -> Result<()> {
    need(
        std::env::current_exe()? == std::path::Path::new(CHECKER),
        "TASK_PERF_FIXED_CHECKER_REQUIRED",
    )?;
    need(
        nix::unistd::geteuid().as_raw() > 0,
        "TASK_PERF_ORDINARY_UID_REQUIRED",
    )?;
    let until = Instant::now() + Duration::from_millis(750);
    std::thread::scope(|scope| {
        let child = std::thread::Builder::new()
            .name("reverie-perf-workload".into())
            .spawn_scoped(scope, move || work(until))?;
        work(until);
        child
            .join()
            .map_err(|_| super::PerfCheckError::Refused("TASK_PERF_WORKLOAD_FAILED"))?;
        Ok(())
    })
}
fn work(until: Instant) {
    let mut value = 1_u64;
    while Instant::now() < until {
        for n in 1..10_000_u64 {
            value = std::hint::black_box(value.wrapping_add(n).wrapping_mul(n));
        }
    }
    std::hint::black_box(value);
}
