use super::*;
use pool::ProtectedPoolMemory;
use reverie_contracts::reservation_engine::NativeLimitBinding;
const ROOT: &str = "/sys/fs/cgroup/reverie.slice/reverie-workers.slice";

fn setup() -> (
    Fixture,
    ReservationConfiguration,
    InventoryRows,
    NativeLimitBinding,
    ObservedMemoryPolicy,
) {
    let fixture = Fixture::new();
    for (p, value) in [
        (
            "/proc/124/stat",
            format!("1 (website fixture) S {} 88", "0 ".repeat(18)),
        ),
        ("/proc/124/cgroup", "0::/website\n".to_owned()),
        (
            "/sys/fs/cgroup/website/memory.max",
            "536870912\n".to_owned(),
        ),
        ("/sys/fs/cgroup/website/memory.swap.max", "0\n".to_owned()),
        ("/sys/fs/cgroup/website/pids.max", "128\n".to_owned()),
        (
            "/proc/123/cgroup",
            "0::/reverie.slice/reverie-workers.slice/worker\n".to_owned(),
        ),
        (
            "/sys/fs/cgroup/reverie.slice/memory.max",
            "max\n".to_owned(),
        ),
        (
            "/sys/fs/cgroup/reverie.slice/memory.swap.max",
            "max\n".to_owned(),
        ),
        ("/sys/fs/cgroup/reverie.slice/pids.max", "max\n".to_owned()),
    ] {
        fixture.write(p, value.as_bytes());
    }
    for (name, value) in [
        ("memory.max", "8589934592"),
        ("memory.high", "7516192768"),
        ("memory.swap.max", "max"),
        ("pids.max", "1024"),
    ] {
        fixture.write(&format!("{ROOT}/{name}"), value.as_bytes());
    }
    for (name, value) in [
        ("memory.max", "2147483648"),
        ("memory.high", "1073741824"),
        ("memory.swap.max", "0"),
        ("pids.max", "128"),
    ] {
        fixture.write(&format!("{ROOT}/worker/{name}"), value.as_bytes());
    }
    let worker = fixture.row();
    let mut site = json!({"Id":"2".repeat(64),"Name":"/website","Image":format!("sha256:{}","a".repeat(64)),"Config":{"Labels":{}},"State":{"Running":true,"Pid":124},"Mounts":[],"HostConfig":{"Memory":536870912,"MemorySwap":536870912,"PidsLimit":128,"NanoCpus":0}});
    site["Id"] = json!("2".repeat(64));
    site["Name"] = json!("/website");
    site["State"]["Pid"] = json!(124);
    site["Config"]["Labels"] = json!({});
    site["HostConfig"]["Memory"] = json!(536870912);
    site["HostConfig"]["MemorySwap"] = json!(536870912);
    let sites = InventoryRows::decode(
        &inventory_ids(&"2".repeat(64)).unwrap(),
        &[site.to_string()],
    )
    .unwrap();
    let website = limits::observe(&fixture, &sites.rows()[0], None, end())
        .unwrap()
        .into_binding();
    let effective = worker_config::decode(br#"{"budgetMode":"pool","memoryMiB":2048,"laptopMemoryPolicy":{"memoryHighMiB":1024,"swapMiB":0}}"#).unwrap();
    let policy = ObservedMemoryPolicy::from_effective(&effective)
        .unwrap()
        .unwrap();
    let config = ReservationConfiguration::capture(
        worker_config::decode(br#"{"poolMemoryMiB":8192,"cgroupParent":"reverie-workers.slice"}"#)
            .unwrap(),
    );
    (fixture, config, worker, website, policy)
}
fn snapshot(
    fixture: &Fixture,
    config: &ReservationConfiguration,
    site: &NativeLimitBinding,
) -> Result<ProtectedPoolMemory> {
    pool::capture(fixture, config, site, end())
}
#[test]
fn protected_pool_charge_requires_actual_member_high_and_preserves_historical_hard_binding() {
    let (fixture, config, rows, site, policy) = setup();
    let binding = limits::observe(&fixture, &rows.rows()[0], Some(&policy), end())
        .unwrap()
        .into_binding();
    let before = binding.canonical_bytes();
    assert_eq!(
        pool::charge(
            &fixture,
            &config,
            &site,
            &rows.rows()[0],
            &binding,
            &policy,
            end()
        )
        .unwrap()
        .as_str(),
        "1073741824"
    );
    assert_eq!(binding.memory().as_str(), "2147483648");
    assert_eq!(binding.canonical_bytes(), before);
    fixture.write(&format!("{ROOT}/worker/memory.high"), b"max");
    assert!(
        pool::charge(
            &fixture,
            &config,
            &site,
            &rows.rows()[0],
            &binding,
            &policy,
            end()
        )
        .is_err()
    );
}
#[test]
fn protected_pool_refuses_unprotected_changed_or_lower_ancestor_limits() {
    let (fixture, config, _, site, _) = setup();
    assert!(snapshot(&fixture, &config, &site).is_ok());
    for value in ["max", "4294967296", "0"] {
        fixture.write(&format!("{ROOT}/memory.max"), value.as_bytes());
        assert!(snapshot(&fixture, &config, &site).is_err());
    }
    fixture.write(&format!("{ROOT}/memory.max"), b"8589934592");
    fixture.write("/sys/fs/cgroup/reverie.slice/memory.max", b"4294967296");
    assert!(snapshot(&fixture, &config, &site).is_err());
    fixture.write("/sys/fs/cgroup/reverie.slice/memory.max", b"max");
    let first = snapshot(&fixture, &config, &site).unwrap();
    fixture.write(&format!("{ROOT}/memory.high"), b"6442450944");
    assert!(pool::current(&fixture, &first, end()).is_err());
}
#[test]
fn protected_pool_close_uncertainty_never_produces_a_discount() {
    let (fixture, config, rows, site, policy) = setup();
    let binding = limits::observe(&fixture, &rows.rows()[0], Some(&policy), end())
        .unwrap()
        .into_binding();
    native::test_faults::set(None, true);
    assert!(
        pool::charge(
            &fixture,
            &config,
            &site,
            &rows.rows()[0],
            &binding,
            &policy,
            end()
        )
        .is_err()
    );
}
#[test]
fn protected_pool_refuses_control_membership_pid_drift_and_rebound_directory() {
    let (fixture, config, _, site, _) = setup();
    fixture.write(
        "/proc/self/cgroup",
        b"0::/reverie.slice/reverie-workers.slice/worker\n",
    );
    fixture.write(&format!("{ROOT}/worker/memory.current"), b"1");
    fixture.write(&format!("{ROOT}/worker/pids.current"), b"1");
    assert!(snapshot(&fixture, &config, &site).is_err());
    fixture.write("/proc/self/cgroup", b"0::/observer\n");
    fixture.write(
        "/proc/124/stat",
        format!("1 (replacement) S {} 89", "0 ".repeat(18)).as_bytes(),
    );
    assert!(snapshot(&fixture, &config, &site).is_err());
    fixture.write(
        "/proc/124/stat",
        format!("1 (website fixture) S {} 88", "0 ".repeat(18)).as_bytes(),
    );
    let first = snapshot(&fixture, &config, &site).unwrap();
    let root = fixture.actual(&path(ROOT));
    fs::rename(&root, root.with_file_name("retained-pool")).unwrap();
    fs::create_dir(&root).unwrap();
    fixture.write(&format!("{ROOT}/memory.max"), b"8589934592");
    fixture.write(&format!("{ROOT}/memory.high"), b"7516192768");
    assert!(pool::current(&fixture, &first, end()).is_err());
}
