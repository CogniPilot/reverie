use super::*;
use reverie_core::ids::ProfileEmployeeId;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[path = "tests_claim.rs"]
mod claim_cases;
#[path = "tests_preparation.rs"]
mod preparation_cases;
fn sha(raw: &[u8]) -> String {
    Sha256::digest(raw)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
struct Setup {
    tree: Tree,
    oracle: Value,
    rows: Vec<Value>,
    stats: [[u64; 4]; 3],
}
impl Setup {
    fn new() -> Self {
        let mut tree = Tree::new();
        let oracle: Value = serde_json::from_str(include_str!(
            "../../../reverie-contracts/tests/fixtures/reservation-observe-python.json"
        ))
        .unwrap();
        let mut config: Value = serde_json::from_slice(&tree.raw).unwrap();
        config["memoryMiB"] = json!(512);
        config["budgetMode"] = json!("admission");
        for name in ["companyId", "poolId", "ownerScopeDigest"] {
            let selected = match name {
                "companyId" => "company",
                "poolId" => "pool",
                _ => "ownerScopeDigest",
            };
            config["resourceReservations"][name] = oracle[selected].clone();
        }
        tree.raw = serde_json::to_vec(&config).unwrap();
        tree.write("worker.json", &tree.raw);
        tree.marker(&config);
        let eid = oracle["employee"]["id"].as_str().unwrap();
        tree.write(
            "company.json",
            &serde_json::to_vec(&json!({"employees":[oracle["employee"]],"retired":[]})).unwrap(),
        );
        let mut profiles = serde_json::Map::new();
        profiles.insert(eid.to_owned(), oracle["profile"].clone());
        tree.write("control/profiles/profiles.json",&serde_json::to_vec(&json!({"schema":"reverie-employee-resource-profiles-v1","revision":1,"profiles":profiles})).unwrap());
        let home = tree.root.join("state/employees").join(eid).join("home");
        let nix = home.with_file_name("nix");
        let scratch = tree.root.join("scratch/employees").join(eid);
        for directory in [&home, &nix, &scratch] {
            fs::create_dir_all(directory).unwrap();
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let paths = [home, nix, scratch];
        let stats = paths.each_ref().map(|path| {
            let info = fs::metadata(path).unwrap();
            [
                info.dev(),
                info.ino(),
                u64::from(info.uid()),
                u64::from(info.gid()),
            ]
        });
        let sid = oracle["employee"]["sessionId"].as_str().unwrap();
        let source = worker_config::decode(&tree.raw).unwrap();
        let effective = crate::resource_staging::effective_config(
            source,
            &reverie_core::ids::ProfileSessionId::parse(sid).unwrap(),
        )
        .unwrap();
        let labels = json!({"reverie.worker":"test","reverie.session":sid,"reverie.employee":eid,"reverie.worker-policy":worker_config::policy_digest(&effective).to_hex()});
        let row = |id: u64, name: &str, labels: Value, mounts: Value| json!({"Id":format!("{id:064x}"),"Name":name,"Image":format!("sha256:{}","a".repeat(64)),"Config":{"Labels":labels},"State":{"Running":true,"Pid":123},"Mounts":mounts,"HostConfig":{"Memory":536870912,"MemorySwap":536870912,"PidsLimit":128,"NanoCpus":0}});
        let mounts=paths.iter().zip(["/home/agent","/nix","/scratch"]).map(|(source,destination)|json!({"Type":"bind","Source":source,"Destination":destination,"RW":true})).collect::<Vec<_>>();
        let rows = vec![
            row(1, "/test-console", json!({}), json!([])),
            row(2, &format!("/test-agent-{sid}"), labels, json!(mounts)),
        ];
        Self {
            tree,
            oracle,
            rows,
            stats,
        }
    }
    fn gate(&self, fixture: &Arc<Fixture>) -> ReservationGate {
        fixture.storage_facts(self.stats);
        for _ in 0..9 {
            fixture.inventory(&self.rows);
        }
        self.tree.gate(fixture, true)
    }
    fn employee(&self) -> ProfileEmployeeId {
        ProfileEmployeeId::parse(self.oracle["employee"]["id"].as_str().unwrap()).unwrap()
    }
    fn expected(&self) -> String {
        let mut source = self.oracle["sourceTemplate"].as_str().unwrap().to_owned();
        for (i, values) in self.stats.iter().enumerate() {
            for (j, value) in values.iter().enumerate() {
                source = source.replace(&format!("@STAT{i}_{j}@"), &value.to_string());
            }
        }
        self.oracle["observationTemplate"]
            .as_str()
            .unwrap()
            .replace("@SOURCE_DIGEST@", &sha(source.as_bytes()))
    }
}
#[test]
fn full_readside_observe_matches_actual_python_journal_bytes_and_hashes() {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    let observed = gate.observe(&setup.employee()).unwrap();
    let expected = setup.expected();
    assert_eq!(observed.canonical_bytes(), expected.as_bytes());
    assert_eq!(observed.digest().as_str(), sha(expected.as_bytes()));
    let journal = observed.journal_data().unwrap();
    assert_eq!(
        operations_v1::observation_digest(&journal),
        observed.digest()
    );
    assert_eq!(
        journal.data().employee_id.as_str(),
        setup.employee().as_str()
    );
}

#[test]
fn install_headroom_uses_real_admission_journal_and_same_native_origin() {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    for _ in 0..12 {
        fixture.inventory(&setup.rows);
    }
    let value = gate.check_headroom().unwrap();
    assert_eq!(value.committed_bytes, 536870912);
    assert_eq!(value.retained_bytes, 0);
    assert!(value.budget_bytes >= value.committed_bytes);
    assert!(gate.inner.state.lock().unwrap().active.is_none());
    let mut lock = AdmissionLock::acquire(&gate.inner.config).unwrap();
    lock.close().unwrap();
}

#[test]
fn retained_delta_requires_current_old_source_instead_of_treating_a_hold_as_credit() {
    use reverie_core::{operations::*, revision::ProfileVersion};
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    for _ in 0..36 {
        fixture.inventory(&setup.rows);
    }
    let observed = operations_v1::decode_observation(setup.expected().as_bytes()).unwrap();
    let data = observed.data();
    let request = OperationRequest {
        employee_id: data.employee_id.clone(),
        pool_id: data.pool_id.clone(),
        source_binding_digest: data.source_binding_digest.clone(),
        profile_version: data.profile_version,
        requested_memory_bytes: MemoryBytes::try_new(data.current_memory_bytes.get() + 256 * MIB)
            .unwrap(),
        preview_digest: JournalDigest::parse(&"a".repeat(64)).unwrap(),
        observation_digest: operations_v1::observation_digest(&observed),
    };
    let op = Operation::try_new(OperationData {
        id: JournalId::parse("88888888-2222-4333-8444-555555555555").unwrap(),
        scope: gate.inner.scope.clone(),
        idempotency_key: key(),
        request_digest: operations_v1::request_digest(&request),
        request,
        reservation_id: JournalId::parse("99999999-2222-4333-8444-555555555555").unwrap(),
        reserved_sid: JournalId::parse(
            setup.oracle["profile"]["binding"]["target_sid"]
                .as_str()
                .unwrap(),
        )
        .unwrap(),
        observation: observed,
        delta_bytes: 256 * MIB,
        version: ProfileVersion::try_new(1).unwrap(),
        state: OperationState::Reserved,
        last_receipt_digest: None,
        reason: None,
    })
    .unwrap();
    let document = OperationDocument::empty().replacing(op).unwrap();
    setup.tree.write(
        "control/operations/operations.json",
        &operations_v1::encode(&document).unwrap(),
    );
    assert_eq!(gate.check_headroom().unwrap().retained_bytes, 256 * MIB);
    fs::remove_file(setup.tree.root.join("company.json")).unwrap();
    assert!(
        gate.check_headroom().is_err(),
        "missing source evidence never credits or drops a retained hold"
    );
    assert_eq!(
        fs::read(setup.tree.root.join("control/operations/operations.json")).unwrap(),
        operations_v1::encode(&document).unwrap()
    );
    assert!(gate.inner.state.lock().unwrap().active.is_none());
}

#[test]
fn pending_count_includes_every_native_name_and_refuses_first_out_of_bound_position() {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    for _ in 0..24 {
        fixture.inventory(&setup.rows);
    }
    // Existing operations.json + operations.lock count too, even though no
    // pending filename is selected. The first4096 names fit; entry4097 refuses.
    for index in 0..4094 {
        setup
            .tree
            .write(&format!("control/operations/unrelated-{index}"), b"{}");
    }
    assert!(gate.check_headroom().is_ok());
    setup
        .tree
        .write("control/operations/one-more-unrelated", b"{}");
    assert_eq!(
        gate.check_headroom().unwrap_err().code(),
        "RESOURCE_COMPLETION_PENDING_BOUND"
    );
    assert!(gate.inner.state.lock().unwrap().active.is_none());
}

#[test]
fn headroom_host_job_and_orphan_pending_refuse_without_credit_or_success_guard() {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    for _ in 0..12 {
        fixture.inventory(&setup.rows);
    }
    setup
        .tree
        .write("control/operations/host-job.finish.pending.json", b"{}");
    assert_eq!(
        gate.check_headroom().unwrap_err().code(),
        "HOST_JOB_FINISH_REQUIRES_RECONCILIATION"
    );
    assert_eq!(
        fixture.events().len(),
        7,
        "only entry guard; body error skips success native guard"
    );
    fs::remove_file(
        setup
            .tree
            .root
            .join("control/operations/host-job.finish.pending.json"),
    )
    .unwrap();
    let id = "99999999-2222-4333-8444-555555555555";
    setup.tree.write(&format!("control/operations/settlement-{id}.pending.json"),&serde_json::to_vec(&json!({"schema":"reverie-resource-settlement-pending-v1","operationId":id,"reservationId":"88888888-2222-4333-8444-555555555555","verifiedReceiptDigest":"a".repeat(64)})).unwrap());
    assert_eq!(
        gate.check_headroom().unwrap_err().code(),
        "RESOURCE_COMPLETION_ORPHAN_PENDING"
    );
    assert!(gate.inner.state.lock().unwrap().active.is_none());
}
#[test]
fn profile_cpu_spelling_change_is_python_equal_without_rewriting_original_digest() {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    let path = setup.tree.root.join("control/profiles/profiles.json");
    let eid = setup.employee().as_str().to_owned();
    fixture.after_storage(move || {
        let mut document: Value = serde_json::from_slice(&fs::read(&path)?)?;
        document["profiles"][&eid]["resources"]["cpus"] = json!(0.0);
        fs::write(path, serde_json::to_vec(&document)?)
    });
    let observed = gate.observe(&setup.employee()).unwrap();
    assert_eq!(observed.canonical_bytes(), setup.expected().as_bytes());
}
#[test]
fn profile_and_employee_drift_after_actual_storage_phase_refuse_before_success_finalizer() {
    for employee_change in [false, true] {
        let setup = Setup::new();
        let fixture = Fixture::new();
        let gate = setup.gate(&fixture);
        let root = setup.tree.root.clone();
        let eid = setup.employee().as_str().to_owned();
        fixture.after_storage(move || {
            let path = root.join(if employee_change {
                "company.json"
            } else {
                "control/profiles/profiles.json"
            });
            let mut document: Value = serde_json::from_slice(&fs::read(&path)?)?;
            if employee_change {
                document["employees"][0]["unrelated"] = json!("changed");
            } else {
                document["profiles"][&eid]["resources"]["memoryMiB"] = json!(1536);
            }
            fs::write(path, serde_json::to_vec(&document)?)
        });
        let error = gate.observe(&setup.employee()).unwrap_err();
        let expected = if employee_change {
            "RESERVATION_EMPLOYEE_CHANGED_DURING_OBSERVATION"
        } else {
            "RESERVATION_PROFILE_CHANGED_DURING_OBSERVATION"
        };
        assert_eq!(error.code(), expected);
        assert!(gate.inner.state.lock().unwrap().active.is_none());
    }
}
