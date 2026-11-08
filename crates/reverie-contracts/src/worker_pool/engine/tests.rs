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
