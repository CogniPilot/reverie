//! Fixed information projection on the original metadata client. DATA only.
use super::*;
use reverie_contracts::worker_pool::{WorkerPoolPolicy, validate_engine_information};

const FORMAT: &str = concat!(
    "{\"ID\":{{json .ID}},\"OSType\":{{json .OSType}},",
    "\"CgroupDriver\":{{json .CgroupDriver}},\"CgroupVersion\":{{json .CgroupVersion}},",
    "\"SecurityOptions\":{{json .SecurityOptions}}}"
);

#[test]
fn pool_information_has_fixed_argv_on_the_same_metadata_owner_without_changing_gpu() {
    let tree = Tree::new();
    let bootstrap = tree.bootstrap("argv");
    let starts = bootstrap.hooks.starts.clone();
    let engine = ReadonlyEngine::new(bootstrap);
    let foreign = tree.engine("other-argv");
    let owner = engine.capture_query_owner();
    let wrong = owner.assert_engine(&foreign).unwrap_err();
    let before = starts.load(Ordering::SeqCst);
    owner.assert_engine(&engine).unwrap();
    let token = CancellationToken::new();
    let pool = owner.query(EngineQuery::WorkerPoolInformation, deadline(), &token);
    let gpu = owner.query(EngineQuery::GpuInformation, deadline(), &token);
    let settled = owner.settle_owned(deadline());
    let closed = engine.close(deadline());
    let foreign_closed = foreign.close(deadline());
    settled.unwrap();
    closed.unwrap();
    foreign_closed.unwrap();
    assert_eq!(wrong.fault(), EngineFault::Identity);
    assert_eq!(
        before, 0,
        "foreign engine is refused before any native read"
    );
    assert_eq!(pool.unwrap(), format!("info\0--format\0{FORMAT}"));
    assert_eq!(
        gpu.unwrap(),
        concat!(
            "info\0--format\0{\"ID\":{{json .ID}},\"OSType\":{{json .OSType}},",
            "\"KernelVersion\":{{json .KernelVersion}},\"ServerVersion\":{{json .ServerVersion}},",
            "\"CDISpecDirs\":{{json .CDISpecDirs}}}"
        )
    );
    assert_eq!(starts.load(Ordering::SeqCst), 2);
}

fn policy() -> WorkerPoolPolicy {
    WorkerPoolPolicy::decode(&serde_json::to_vec(&serde_json::json!({
        "version":1,"purpose":"reverie-docker-worker-pool-v1","deployment":"query-fixture",
        "instanceRoot":"/home/fixture/reverie","engineId":"11111111-1111-4111-8111-111111111111",
        "anchorImage":format!("sha256:{}","a".repeat(64)),"controllerImage":format!("sha256:{}","b".repeat(64)),
        "websiteContainer":"c".repeat(64),"brokerUid":1000,"brokerGid":100,"memoryMaxMiB":49152,
        "poolTasksMax":8192,"cpuWeight":100,"allowedCpus":[0,1],
        "employeeMemoryHighMiB":{"22222222-2222-4222-8222-222222222222":1536}
    })).unwrap()).unwrap()
}

#[test]
fn pool_information_read_feeds_the_existing_daemon_codec_and_keeps_invalid_data_refused() {
    let tree = Tree::new();
    let bootstrap = tree.bootstrap("worker-pool-info");
    let starts = bootstrap.hooks.starts.clone();
    let engine = ReadonlyEngine::new(bootstrap);
    let owner = engine.capture_query_owner();
    let policy = policy();
    let valid = serde_json::json!({"ID":policy.engine_id,"OSType":"linux",
        "CgroupDriver":"systemd","CgroupVersion":"2","SecurityOptions":["name=seccomp,profile=builtin","name=cgroupns"]});
    let mut results = Vec::new();
    for invalid in [
        None,
        Some(("ID", serde_json::json!("foreign"))),
        Some(("CgroupDriver", serde_json::json!("cgroupfs"))),
        Some(("CgroupVersion", serde_json::json!("1"))),
        Some(("SecurityOptions", serde_json::json!(["name=rootless"]))),
        Some(("SecurityOptions", serde_json::Value::Null)),
    ] {
        let mut data = valid.clone();
        if let Some((key, value)) = invalid {
            data[key] = value;
        }
        fs::write(
            tree.root.join("info.json"),
            serde_json::to_vec(&data).unwrap(),
        )
        .unwrap();
        let observed = owner
            .query(
                EngineQuery::WorkerPoolInformation,
                deadline(),
                &CancellationToken::new(),
            )
            .map(|raw| validate_engine_information(raw.as_bytes(), &policy).is_ok());
        results.push(observed);
    }
    let trace = fs::read_to_string(tree.root.join("calls.txt"));
    let settled = owner.settle_owned(deadline());
    let closed = engine.close(deadline());
    settled.unwrap();
    closed.unwrap();
    let results = results.into_iter().map(Result::unwrap).collect::<Vec<_>>();
    assert_eq!(results, [true, false, false, false, false, false]);
    assert_eq!(starts.load(Ordering::SeqCst), 6);
    assert_eq!(
        trace.unwrap().lines().collect::<Vec<_>>(),
        vec![format!("info\0--format\0{FORMAT}"); 6]
    );
}
