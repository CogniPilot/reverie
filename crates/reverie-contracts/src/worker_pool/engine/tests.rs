//! Pure Engine inspection DATA only; no native controller or pool owner.
use super::*;
fn policy() -> WorkerPoolPolicy {
    WorkerPoolPolicy {
        version: 1,
        purpose: PURPOSE.into(),
        deployment: "reserve-fixture".into(),
        instance_root: "/home/owned/reverie".into(),
        engine_id: "11111111-1111-4111-8111-111111111111".into(),
        anchor_image: format!("sha256:{}", "a".repeat(64)),
        controller_image: format!("sha256:{}", "b".repeat(64)),
        website_container: "c".repeat(64),
        broker_uid: 1000,
        broker_gid: 1000,
        memory_max_mi_b: MEMORY_MAX_MIB,
        pool_tasks_max: TASKS_MAX,
        cpu_weight: 100,
        allowed_cpus: vec![0, 1],
        employee_memory_high_mi_b: BTreeMap::from([(
            "22222222-2222-4222-8222-222222222222".into(),
            512,
        )]),
    }
}

#[test]
#[ignore = "requires explicitly selected private recorded birth and failed inspection DATA; no native effects"]
fn recorded_failed_service_v2_preserves_actual_readback_and_rejects_environment_overrides() {
    use sha2::{Digest, Sha256};
    let birth_bytes =
        std::fs::read(std::env::var_os("REVERIE_POOL_RECORDED_BIRTH").unwrap()).unwrap();
    let birth = ControllerBirthV2::decode(&birth_bytes).unwrap();
    let raw = std::fs::read(std::env::var_os("REVERIE_POOL_RECORDED_INSPECTION").unwrap()).unwrap();
    let value: Value = serde_json::from_slice(&raw).unwrap();
    let cid = value["Id"].as_str().unwrap();
    let name = value["Name"].as_str().unwrap().strip_prefix('/').unwrap();
    let digest = value["Config"]["Labels"]["reverie.pool.birth-policy"]
        .as_str()
        .unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&birth_bytes)), digest);
    let check = |bytes: &[u8]| {
        validate_failed_controller_service_v2_inspection(bytes, birth.policy(), cid, digest, name)
    };
    check(&raw).unwrap();
    assert!(
        validate_controller_service_v2_inspection(&raw, birth.policy(), cid, 0, digest).is_err()
    );
    for env in [
        json!(["LANG=C.UTF-8", "PATH=/bin", "EXTRA=1"]),
        json!(["LANG=C.UTF-8", "LANG=C.UTF-8"]),
        json!(["LANG=C.UTF-8", "PATH=/other"]),
    ] {
        let mut changed = value.clone();
        changed["Config"]["Env"] = env;
        assert!(check(&serde_json::to_vec(&changed).unwrap()).is_err());
    }
}
fn controller(policy: &WorkerPoolPolicy) -> Value {
    let digest = "d".repeat(64);
    let mounts = [
        (format!("{}/worker-pool/policies",policy.instance_root),"/run/reverie-worker-pool/policies",false),
        ("/proc".into(),"/run/reverie-host-proc",false),
        ("/sys/fs/cgroup".into(),"/sys/fs/cgroup",true),
        ("/var/run/docker.sock".into(),"/run/reverie-engine.sock",false),
    ].into_iter().map(|(source,target,writable)| json!({"Type":"bind","Source":source,"Destination":target,"RW":writable,"Propagation":"rprivate"})).collect::<Vec<_>>();
    json!({
        "Id":"e".repeat(64),"Image":policy.controller_image,"Name":format!("/{}",policy.controller_name()),
        "State":{"Pid":123,"Running":true,"Paused":false,"Restarting":false},
        "Config":{"User":format!("0:{}",policy.broker_gid),"Entrypoint":["/bin/reverie-worker-resource-controller"],
            "Cmd":["serve","--policy-sha256",digest],"Env":["PATH=/bin","LANG=C.UTF-8"],
            "Labels":{"reverie.resource-controller":policy.deployment,"reverie.pool.purpose":PURPOSE,"reverie.pool.birth-policy":digest}},
        "HostConfig":{"Privileged":false,"ReadonlyRootfs":true,"PidMode":"host","CgroupnsMode":"host","UsernsMode":"host",
            "NetworkMode":"none","CgroupParent":"system.slice","CapDrop":["ALL"],"CapAdd":null,"GroupAdd":null,
            "SecurityOpt":["no-new-privileges:true"],"Memory":CONTROLLER_MEMORY_BYTES,"MemorySwap":CONTROLLER_MEMORY_BYTES,
            "PidsLimit":CONTROLLER_TASKS_MAX,"CpuQuota":0,"CpuPeriod":0,"NanoCpus":0,"CpusetCpus":policy.cpu_list()},
        "Mounts":mounts
    })
}
fn valid(value: &Value, policy: &WorkerPoolPolicy) -> bool {
    validate_controller_inspection(
        &serde_json::to_vec(value).unwrap(),
        policy,
        &"e".repeat(64),
        123,
        &"d".repeat(64),
    )
    .is_ok()
}
#[test]
fn fixed_controller_reserve_accepts_only_the_bounded_producer_declaration() {
    let policy = policy();
    policy.validate().unwrap();
    let original = controller(&policy);
    assert!(valid(&original, &policy));
    assert_eq!(CONTROLLER_MEMORY_BYTES, 268_435_456);
    assert_eq!(CONTROLLER_TASKS_MAX, 128);
    for field in ["Memory", "MemorySwap", "PidsLimit"] {
        for value in [
            json!(null),
            json!(0),
            json!(-1),
            json!(1),
            json!(536_870_912),
        ] {
            let mut changed = original.clone();
            changed["HostConfig"][field] = value;
            assert!(!valid(&changed, &policy), "{field}");
        }
        let mut changed = original.clone();
        changed["HostConfig"].as_object_mut().unwrap().remove(field);
        assert!(!valid(&changed, &policy), "missing {field}");
    }
}
#[test]
fn controller_reserve_rejects_cpu_quota_or_different_placement() {
    let policy = policy();
    let original = controller(&policy);
    for (field, value) in [
        ("CpuQuota", json!(100_000)),
        ("CpuPeriod", json!(10_000)),
        ("NanoCpus", json!(1)),
        ("CpusetCpus", json!("2,3")),
        ("CpusetCpus", json!("")),
    ] {
        let mut changed = original.clone();
        changed["HostConfig"][field] = value;
        assert!(!valid(&changed, &policy), "{field}");
    }
}

fn service_v2(policy: &WorkerPoolPolicy) -> Value {
    let mut value = controller(policy);
    value["Config"]["Cmd"] = json!([
        "serve",
        "--confinement-version",
        "2",
        "--birth-sha256",
        "d".repeat(64)
    ]);
    value["Config"]["Labels"]["reverie.pool.purpose"] =
        json!(super::super::controller_v2::SERVICE_PURPOSE);
    value["Mounts"].as_array_mut().unwrap().push(json!({
        "Type":"bind","Source":format!("{}/worker-pool/control",policy.instance_root),
        "Destination":"/run/reverie-worker-pool/control","RW":true,"Propagation":"rprivate"}));
    value
}
fn valid_v2(value: &Value, policy: &WorkerPoolPolicy) -> bool {
    validate_controller_service_v2_inspection(
        &serde_json::to_vec(value).unwrap(),
        policy,
        &"e".repeat(64),
        123,
        &"d".repeat(64),
    )
    .is_ok()
}
#[test]
fn service_v2_is_exact_fifth_control_bind_without_silently_relaxing_v1() {
    let policy = policy();
    let old = controller(&policy);
    let new = service_v2(&policy);
    assert!(valid(&old, &policy));
    assert!(!valid_v2(&old, &policy));
    assert!(valid_v2(&new, &policy));
    assert!(!valid(&new, &policy));
    for (index, field, bad) in [
        (0, "RW", json!(true)),
        (4, "RW", json!(false)),
        (4, "Source", json!("/arbitrary")),
        (4, "Destination", json!("/run/other")),
        (4, "Propagation", json!("rshared")),
    ] {
        let mut changed = new.clone();
        changed["Mounts"][index][field] = bad;
        assert!(!valid_v2(&changed, &policy));
    }
    let mut extra = new.clone();
    extra["Mounts"].as_array_mut().unwrap().push(json!({}));
    assert!(!valid_v2(&extra, &policy));
    for (field, bad) in [
        ("CapAdd", json!(["SYS_PTRACE"])),
        ("PidMode", json!("private")),
        ("ReadonlyRootfs", json!(false)),
        ("Privileged", json!(true)),
    ] {
        let mut changed = new.clone();
        changed["HostConfig"][field] = bad;
        assert!(!valid_v2(&changed, &policy));
    }
}
#[test]
fn service_v2_accepts_docker_environment_order_without_accepting_overrides() {
    let policy = policy();
    let mut value = service_v2(&policy);
    value["Config"]["Env"] = json!(["LANG=C.UTF-8", "PATH=/bin"]);
    assert!(valid_v2(&value, &policy));
    for bad in [
        json!([]),
        json!(["PATH=/bin"]),
        json!(["PATH=/bin", "PATH=/bin"]),
        json!(["LANG=C.UTF-8", "PATH=/bin", "PATH=/elsewhere"]),
        json!(["PATH=/bin", "LANG=C.UTF-8", "EXTRA=1"]),
        json!(["PATH=/elsewhere", "LANG=C.UTF-8"]),
        json!(["PATH=/bin", "LANG=C"]),
        json!(["LANG=C.UTF-8", null]),
        json!({"PATH":"/bin","LANG":"C.UTF-8"}),
    ] {
        value["Config"]["Env"] = bad;
        assert!(!valid_v2(&value, &policy));
    }
    let mut original = controller(&policy);
    original["Config"]["Env"] = json!(["LANG=C.UTF-8", "PATH=/bin"]);
    assert!(!valid(&original, &policy));
}
#[test]
fn failed_startup_classification_is_exact_and_not_a_general_error_allowlist() {
    assert!(super::super::failed_controller_startup_log(
        b"WORKER_POOL_CONTROLLER_SPEC\n"
    ));
    for bad in [
        b"WORKER_POOL_CONTROLLER_SPEC".as_slice(),
        b"WORKER_POOL_CONTROLLER_SPEC\nOTHER_FAILURE\n",
        b"WORKER_POOL_PARENT_WRITE\n",
        b"",
    ] {
        assert!(!super::super::failed_controller_startup_log(bad));
    }
}
