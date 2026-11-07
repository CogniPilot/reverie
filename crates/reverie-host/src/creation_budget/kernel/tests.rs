use super::*;
use reverie_core::resources::CpuQuota;
use std::{cell::RefCell, collections::BTreeMap, time::Duration};
struct Fixture {
    files: BTreeMap<String, String>,
    reads: RefCell<Vec<String>>,
}
impl Fixture {
    fn new(memory: &str, tasks: &str, current: &str) -> Self {
        Self {
            files: [
                (format!("{POOL}/memory.max"), memory.into()),
                (format!("{POOL}/pids.max"), tasks.into()),
                (format!("{POOL}/pids.current"), current.into()),
            ]
            .into(),
            reads: RefCell::new(Vec::new()),
        }
    }
}
impl Source for Fixture {
    fn text(&self, path: &str) -> Result<String> {
        self.reads.borrow_mut().push(path.into());
        self.files
            .get(path)
            .cloned()
            .ok_or(CreationHostError::Encoding)
    }
}
fn resources(mode: BudgetMode) -> ResourcePolicy {
    ResourcePolicy::try_new(
        mode,
        512,
        128,
        CpuQuota::from_integer(0).unwrap(),
        4096,
        1024,
    )
    .unwrap()
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(2)
}
#[test]
fn creation_pool_converts_memory_before_next_read_but_defers_positivity() {
    let invalid = Fixture::new("max", "unused", "0");
    assert!(matches!(
        pool(&invalid, end()),
        Err(CreationHostError::Data(CreationBudgetError::Integer))
    ));
    assert_eq!(*invalid.reads.borrow(), [format!("{POOL}/memory.max")]);
    let negative = Fixture::new("-1", "not-an-int", "0");
    assert!(matches!(
        pool(&negative, end()),
        Err(CreationHostError::Data(CreationBudgetError::Integer))
    ));
    assert_eq!(
        *negative.reads.borrow(),
        [format!("{POOL}/memory.max"), format!("{POOL}/pids.max")]
    );
}
#[test]
fn separate_pool_check_reads_all_counters_and_preserves_native_failure_source() {
    let fixture = Fixture::new("4294967296", "1024", "960");
    check_pool(&fixture, &resources(BudgetMode::Pool), true, end()).unwrap();
    assert_eq!(
        *fixture.reads.borrow(),
        [
            format!("{POOL}/memory.max"),
            format!("{POOL}/pids.max"),
            format!("{POOL}/pids.current")
        ]
    );
    let mut missing = Fixture::new("4294967296", "1024", "0");
    missing.files.remove(&format!("{POOL}/pids.max"));
    let error = check_pool(&missing, &resources(BudgetMode::Pool), true, end()).unwrap_err();
    assert!(
        matches!(error,CreationHostError::PoolActivation {ref cause} if matches!(cause.as_ref(),CreationHostError::Encoding))
    );
    assert!(std::error::Error::source(&error).is_some());
    assert_eq!(missing.reads.borrow().len(), 2);
}
#[test]
fn admission_pool_phase_does_no_kernel_io_and_expired_pool_never_opens() {
    let fixture = Fixture::new("unused", "unused", "unused");
    check_pool(
        &fixture,
        &resources(BudgetMode::Admission),
        true,
        Instant::now() - Duration::from_secs(1),
    )
    .unwrap();
    assert!(fixture.reads.borrow().is_empty());
    assert!(
        check_pool(
            &fixture,
            &resources(BudgetMode::Pool),
            true,
            Instant::now() - Duration::from_secs(1)
        )
        .is_err()
    );
    assert!(fixture.reads.borrow().is_empty());
}
