use super::*;
use reverie_contracts::worker_config;
use reverie_core::{
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    worker_schema::{WorkerBase, WorkerIds},
};
use serde_json::{Value, json};
use std::cell::RefCell;
struct Fixture<'a> {
    case: &'a Value,
    events: RefCell<Vec<Vec<String>>>,
    kernel: RefCell<Vec<&'static str>>,
}

#[test]
fn present_explicit_control_never_falls_back_to_legacy_budget_without_real_scope() {
    let config =
        worker_config::decode(br#"{"poolMemoryMiB":4096,"resourceReservations":null}"#).unwrap();
    let resources =
        worker_config::decode(br#"{"budgetMode":"admission","memoryMiB":999999}"#).unwrap();
    let session = ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap();
    let case = json!({"listed":[]});
    let fixture = Fixture {
        case: &case,
        events: RefCell::new(Vec::new()),
        kernel: RefCell::new(Vec::new()),
    };
    let inputs = Inputs {
        config: &config,
        resources: &resources,
        session: &session,
        deployment: "test",
        max_workers: 4,
    };
    assert_eq!(
        check(&inputs, &[], None, None, &fixture)
            .unwrap_err()
            .code(),
        "Resource reservation control requires reconciliation"
    );
    assert_eq!(fixture.events.borrow().len(), 1);
    assert!(fixture.kernel.borrow().is_empty());
}

#[test]
fn direct_peer_fields_precede_real_effective_company_io_and_ram_type_checks() {
    use crate::{reservation_gate::tests::Tree, worker_validation::validate_captured};
    let oracle: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/creation-peer-effective-priority-python.json"
    ))
    .unwrap();
    let session = ProfileSessionId::parse("11111111-2222-4333-8444-555555555555").unwrap();
    for case in oracle["cases"].as_array().unwrap() {
        let tree = Tree::new();
        let mut config: Value = serde_json::from_slice(&tree.raw).unwrap();
        config
            .as_object_mut()
            .unwrap()
            .remove("resourceReservations");
        config["employeeMemoryPolicies"] =
            json!({"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee":{"swapMiB":0}});
        config["laptopSwapPoolMiB"] = json!(0);
        let snapshot = validate_captured(
            worker_config::decode(&serde_json::to_vec(&config).unwrap()).unwrap(),
        )
        .unwrap();
        let resources =
            worker_config::decode(br#"{"budgetMode":"admission","memoryMiB":512}"#).unwrap();
        let data = json!({"listed":["test-agent-22222222-2222-4333-8444-555555555555"],"inspectText":case["rowText"],"inspectSucceeded":true,"cgroup":"0::/outside\n"});
        let source = Fixture {
            case: &data,
            events: RefCell::new(Vec::new()),
            kernel: RefCell::new(Vec::new()),
        };
        let inputs = Inputs {
            config: snapshot.configuration(),
            resources: &resources,
            session: &session,
            deployment: "test",
            max_workers: 4,
        };
        let error = check(&inputs, &[], None, None, &source).unwrap_err();
        if case["missingMemorySwap"].as_bool().unwrap() {
            assert_eq!(case["error"]["type"], "KeyError");
            assert!(matches!(
                error,
                CreationBudgetError::Data(data::CreationBudgetError::Structure)
            ));
        } else {
            assert_eq!(case["error"]["type"], "FileNotFoundError");
            assert!(
                matches!(error, CreationBudgetError::Effective(_)),
                "actual selected company file is absent: {error:?}"
            );
        }
        assert_eq!(*source.kernel.borrow(), ["cgroup"]);
        assert_eq!(source.events.borrow().len(), 2);
    }
}

#[test]
fn explicit_creation_budget_uses_actual_retained_scope_after_peer_prefix() {
    crate::test_process::owning_case!(
        explicit_creation_budget_uses_actual_retained_scope_after_peer_prefix
    );
    use crate::{
        reservation_gate::{AdmissionBounds, tests::Tree},
        reservation_observer::tests::Fixture as NativeFixture,
        worker_validation::load_owner_config,
    };
    let tree = Tree::new();
    let native = NativeFixture::new();
    let row = json!({"Id":"a".repeat(64),"Name":"/test-console","Image":format!("sha256:{}","a".repeat(64)),"Config":{"Labels":{}},"State":{"Running":true,"Pid":123},"Mounts":[],"HostConfig":{"Memory":536870912,"MemorySwap":536870912,"PidsLimit":128,"NanoCpus":0}});
    for _ in 0..80 {
        native.inventory(std::slice::from_ref(&row));
    }
    let gate = ReservationGate::new(
        load_owner_config(&tree.root.join("worker.json")).unwrap(),
        native.observer(),
    )
    .unwrap();
    let session = ProfileSessionId::parse("11111111-2222-4333-8444-555555555555").unwrap();
    let admission = gate
        .admit_ordinary_launch(&session, AdmissionBounds::default())
        .unwrap();
    let config = worker_config::decode(&tree.raw).unwrap();
    let mut candidate: Value = serde_json::from_slice(&tree.raw).unwrap();
    candidate["budgetMode"] = json!("admission");
    candidate["memoryMiB"] = json!(512);
    let resources = worker_config::decode(&serde_json::to_vec(&candidate).unwrap()).unwrap();
    let case = json!({"listed":[]});
    let fixture = Fixture {
        case: &case,
        events: RefCell::new(Vec::new()),
        kernel: RefCell::new(Vec::new()),
    };
    let inputs = Inputs {
        config: &config,
        resources: &resources,
        session: &session,
        deployment: "test",
        max_workers: 4,
    };
    let before = native.events().len();
    check(&inputs, &[], Some(&gate), Some(&admission), &fixture).unwrap();
    assert_eq!(fixture.events.borrow().len(), 1);
    assert!(
        fixture.kernel.borrow().is_empty(),
        "explicit gate does not substitute legacy pool reads"
    );
    assert!(
        native.events().len() > before,
        "actual gate performs its own capacity and final inventory"
    );
    admission.close().unwrap();
}
impl Source for Fixture<'_> {
    fn names(&self) -> Result<String> {
        self.events.borrow_mut().push(
            [
                "ps",
                "--filter",
                "label=reverie.worker=test",
                "--format",
                "{{.Names}}",
            ]
            .map(str::to_owned)
            .to_vec(),
        );
        Ok(self.case["listed"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| name.as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n"))
    }
    fn inspect(
        &self,
        name: &CreationPeerName<'_>,
    ) -> Result<reverie_host::broker_engine::LaptopInspectOutput> {
        self.events
            .borrow_mut()
            .push(vec!["inspect".into(), name.name().into()]);
        Ok(reverie_host::broker_engine::LaptopInspectOutput {
            stdout: self.case["inspectText"]
                .as_str()
                .unwrap()
                .as_bytes()
                .to_vec(),
            succeeded: self.case["inspectSucceeded"].as_bool().unwrap(),
        })
    }
    fn pooled(&self, _: &PeerProcessId) -> Result<bool> {
        self.kernel.borrow_mut().push("cgroup");
        Ok(data::creation_peer_uses_pool(
            self.case["cgroup"].as_str().unwrap(),
        )?)
    }
    fn host_root(&self) -> Result<()> {
        self.kernel.borrow_mut().push("host");
        Ok(())
    }
    fn swap_total(&self) -> Result<UnsignedInteger> {
        self.kernel.borrow_mut().push("swap");
        Ok(
            reverie_contracts::kernel_accounting::swap_total(
                self.case["meminfo"].as_str().unwrap(),
            )
            .map_err(CreationHostError::KernelData)?,
        )
    }
    fn pool(&self) -> Result<LegacyPoolLimits> {
        self.kernel.borrow_mut().push("memory.max");
        let memory = LegacyPoolLimits::capture_memory(self.case["poolMemory"].as_str().unwrap())?;
        self.kernel.borrow_mut().push("pids.max");
        Ok(memory.finish(self.case["poolTasks"].as_str().unwrap())?)
    }
    fn total(&self) -> Result<Option<UnsignedInteger>> {
        self.kernel.borrow_mut().push("meminfo");
        Ok(data::legacy_memtotal(
            self.case["meminfo"].as_str().unwrap(),
        )?)
    }
}

#[test]
fn swap_phase_matches_12_actual_python_projected_candidate_and_peer_cases() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/creation-swap-python.json"
    ))
    .unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let config = ReservationConfiguration::capture(
            worker_config::decode(case["config"].to_string().as_bytes()).unwrap(),
        );
        let candidate =
            worker_config::decode(case["candidateText"].as_str().unwrap().as_bytes()).unwrap();
        let peer =
            CreationPeerInspection::decode(case["rowsText"].as_str().unwrap().as_bytes()).unwrap();
        let fixture = Fixture {
            case,
            events: RefCell::new(Vec::new()),
            kernel: RefCell::new(Vec::new()),
        };
        let result = swap_budget(&config, &[peer], &candidate, &fixture);
        assert_eq!(
            result.err().map(|error| error.code()),
            case["error"]["message"].as_str(),
            "{}",
            case["name"]
        );
        assert_eq!(
            fixture.kernel.borrow().first(),
            Some(&"host"),
            "host-root qualification precedes declaration/candidate checks"
        );
        if case["error"]["message"] == "Laptop swap admission is full"
            || case["name"] == "zero-pool"
            || case["error"]["message"] == "Finite laptop RAM and swap declarations required"
        {
            assert_eq!(*fixture.kernel.borrow(), ["host"], "{}", case["name"]);
        }
    }
}
fn base() -> WorkerBase {
    WorkerBase::try_new(
        "test".into(),
        "test-console".into(),
        format!("sha256:{}", "a".repeat(64)),
        WorkerIds::try_new(1000, 1000).unwrap(),
        4,
        ResourcePolicy::try_new(
            BudgetMode::Admission,
            512,
            128,
            CpuQuota::from_integer(0).unwrap(),
            4096,
            1024,
        )
        .unwrap(),
    )
    .unwrap()
}
fn expected(case: &Value) -> Option<&str> {
    let error = &case["error"];
    if error.is_null() {
        return None;
    }
    Some(match error["type"].as_str().unwrap() {
        "RuntimeError" => error["message"].as_str().unwrap(),
        "JSONDecodeError" => "WORKER_CREATION_PEER_JSON",
        "TypeError" | "KeyError" | "AttributeError" => "WORKER_CREATION_PEER_STRUCTURE",
        "ValueError"
            if error["message"]
                .as_str()
                .unwrap()
                .starts_with("Exceeds the limit") =>
        {
            "WORKER_CREATION_PEER_JSON"
        }
        "ValueError" => "PYTHON_INTEGER_CONVERSION",
        "StopIteration" => "WORKER_CREATION_MEMTOTAL_MISSING",
        "IndexError" => "WORKER_CREATION_MEMTOTAL_FIELD",
        other => panic!("unmapped actual Python failure {other}"),
    })
}
#[test]
fn complete_legacy_creation_budget_matches_55_actual_python_recipes_and_engine_phases() {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/creation-budget-python.json"
    ))
    .unwrap();
    let session = ProfileSessionId::parse("11111111-2222-4333-8444-555555555555").unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let config = worker_config::decode(case["config"].to_string().as_bytes()).unwrap();
        let resources = worker_config::decode(case["resources"].to_string().as_bytes()).unwrap();
        let registry = case["registry"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| {
                let sid = name.as_str().unwrap().strip_prefix("test-agent-").unwrap();
                WorkerContainerName::for_session(&base(), &ProfileSessionId::parse(sid).unwrap())
            })
            .collect::<Vec<_>>();
        let fixture = Fixture {
            case,
            events: RefCell::new(Vec::new()),
            kernel: RefCell::new(Vec::new()),
        };
        let inputs = Inputs {
            config: &config,
            resources: &resources,
            session: &session,
            deployment: "test",
            max_workers: usize::try_from(case["config"]["maxWorkers"].as_u64().unwrap()).unwrap(),
        };
        let result = check(&inputs, &registry, None, None, &fixture);
        assert_eq!(
            result.err().map(|error| error.code()),
            expected(case),
            "{}",
            case["name"]
        );
        let calls = case["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| {
                event["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|arg| arg.as_str().unwrap().to_owned())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        assert_eq!(*fixture.events.borrow(), calls, "{}", case["name"]);
        if case["name"] == "no-peers" {
            assert!(
                fixture.kernel.borrow().is_empty(),
                "no-pool branch reads no kernel counters"
            );
        }
        if case["name"] == "pool-max" {
            assert_eq!(
                *fixture.kernel.borrow(),
                ["memory.max"],
                "integer conversion precedes next native read"
            );
        }
    }
}
