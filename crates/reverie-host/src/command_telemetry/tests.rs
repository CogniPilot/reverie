use super::*;
use reverie_core::{
    command_telemetry::FailureReportRequest,
    ids::{ProfileEmployeeId, ProfileSessionId},
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    worker_schema::{WorkerBase, WorkerIds},
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
mod native_reference;
const E: &str = "11111111-1111-1111-1111-111111111111";
const S: &str = "22222222-2222-2222-2222-222222222222";
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let _ = crate::engine_metadata::tests::program();
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "telemetry-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        for leaf in ["state", "company"] {
            fs::create_dir(root.join(leaf)).unwrap();
            fs::set_permissions(root.join(leaf), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let tree = Self(root);
        tree.company(false, "owner");
        fs::write(tree.0.join("ps.out"), b"").unwrap();
        fs::write(tree.0.join("inspect.out"), b"[{\"Mounts\":[]}]").unwrap();
        tree
    }
    fn company(&self, retired: bool, owner: &str) {
        let row = json!({"id":E,"owner":owner,"sessionId":S,"desiredRunning":true});
        let company = if retired {
            json!({"employees":[],"retired":[row]})
        } else {
            json!({"employees":[row]})
        };
        fs::write(
            self.0.join("company/employees.json"),
            serde_json::to_vec(&company).unwrap(),
        )
        .unwrap();
        fs::set_permissions(
            self.0.join("company/employees.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    fn raw(&self) -> serde_json::Value {
        json!({"uid":native::uid(),"stateRoot":self.0.join("state"),"scratchRoot":self.0.join("scratch"),"apiSocketRoot":self.0.join("api"),"companyRoot":self.0.join("company"),"companyFile":self.0.join("company/employees.json"),"mounts":[],"commandTelemetry":{"enabled":true,"keys":["shell"]}})
    }
    fn config(&self) -> EffectiveWorkerConfig {
        config(self.raw())
    }
    fn runtime(&self) -> WorkerRuntime {
        let program = self.0.join("command-telemetry");
        if !program.exists() {
            fs::hard_link(crate::engine_metadata::tests::program(), &program).unwrap();
        }
        let bootstrap = crate::engine_metadata::EngineBootstrap::from_service(
            program.as_os_str(),
            BTreeMap::new(),
            self.0.clone(),
        )
        .unwrap();
        let base = WorkerBase::try_new(
            "fixture".into(),
            "fixture-server".into(),
            format!("sha256:{}", "a".repeat(64)),
            WorkerIds::try_new(native::uid(), native::uid()).unwrap(),
            4,
            ResourcePolicy::try_new(
                BudgetMode::Admission,
                1024,
                128,
                CpuQuota::from_integer(1).unwrap(),
                8192,
                512,
            )
            .unwrap(),
        )
        .unwrap();
        WorkerRuntime::new(InstalledWorkerEngine::new(bootstrap), &base)
    }
    fn sink(&self) -> PathBuf {
        self.0.join("state/command-telemetry")
    }
    fn database(&self) -> PathBuf {
        self.sink().join(E).join("hands/command-failures.sqlite")
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn config(value: serde_json::Value) -> EffectiveWorkerConfig {
    reverie_contracts::worker_config::decode(&serde_json::to_vec(&value).unwrap()).unwrap()
}
fn args(values: &[&str]) -> Vec<MetadataText> {
    values
        .iter()
        .map(|value| MetadataText::from_scalar_text(value))
        .collect()
}
fn event() -> Vec<u8> {
    serde_json::to_vec(&json!({"v":1,"tool":"shell","exit_code":127,"execution_id":"00000000-0000-0000-0000-000000000000"})).unwrap()
}
#[test]
fn disabled_capture_has_no_uid_path_engine_or_sink_reads_but_keeps_real_origin() {
    let tree = Tree::new();
    let runtime = tree.runtime();
    let telemetry = CommandTelemetry::capture(&runtime, &config(json!({}))).unwrap();
    assert!(!telemetry.enabled());
    assert!(!tree.sink().exists());
    assert!(!tree.0.join("calls.txt").exists());
    telemetry
        .check_create_args(&runtime, &args(&["--volume"]))
        .unwrap();
    assert!(!telemetry.observe(&ProfileSessionId::parse(S).unwrap(), &event()));
    assert!(telemetry.check_create_args(&tree.runtime(), &[]).is_err());
}
#[test]
fn actual_constructor_filtered_inventory_complete_mounts_then_sink_creation() {
    let tree = Tree::new();
    let runtime = tree.runtime();
    fs::write(tree.0.join("ps.out"), format!("{}\n", "a".repeat(12))).unwrap();
    let telemetry = CommandTelemetry::capture(&runtime, &tree.config()).unwrap();
    assert!(telemetry.enabled());
    assert!(tree.sink().is_dir());
    let trace = fs::read_to_string(tree.0.join("calls.txt")).unwrap();
    assert_eq!(
        trace,
        format!(
            "ps\0--all\0--filter\0label=reverie.worker\0--format\0{{{{.ID}}}}\ninspect\0{}\n",
            "a".repeat(12)
        )
    );
    assert_eq!(
        fs::metadata(tree.sink()).unwrap().permissions().mode() & 0o777,
        0o700
    );
}
#[test]
fn source_and_inventory_refusals_never_initialize_sink_and_validate_all_ids_first() {
    let tree = Tree::new();
    let runtime = tree.runtime();
    let mut raw = tree.raw();
    raw["mounts"] = json!([{"source":tree.0.join("state")}]);
    assert!(CommandTelemetry::capture(&runtime, &config(raw)).is_err());
    assert!(!tree.0.join("calls.txt").exists());
    assert!(!tree.sink().exists());
    fs::write(tree.0.join("ps.out"), format!("{}\nBAD\n", "a".repeat(12))).unwrap();
    assert!(CommandTelemetry::capture(&runtime, &tree.config()).is_err());
    assert!(!tree.sink().exists());
    assert_eq!(
        fs::read_to_string(tree.0.join("calls.txt"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}
#[test]
fn final_argv_refuses_hidden_sources_aliases_and_late_mount_forms() {
    let tree = Tree::new();
    let runtime = tree.runtime();
    let telemetry = CommandTelemetry::capture(&runtime, &tree.config()).unwrap();
    for source in [
        tree.sink(),
        tree.sink().join("future"),
        tree.0.join("state"),
    ] {
        assert!(
            telemetry
                .check_create_args(
                    &runtime,
                    &args(&[
                        "image",
                        "--mount",
                        &format!("type=bind,src={}", source.display())
                    ])
                )
                .is_err()
        );
    }
    let alias = tree.0.join("alias");
    std::os::unix::fs::symlink(tree.0.join("safe"), &alias).unwrap();
    assert!(
        telemetry
            .check_create_args(
                &runtime,
                &args(&["--mount", &format!("type=bind,src={}", alias.display())])
            )
            .is_err()
    );
    telemetry
        .check_create_args(
            &runtime,
            &args(&[
                "--mount",
                "type=tmpfs,src=/ignored",
                "--mount",
                &format!("type=bind,src={}", tree.0.join("safe").display()),
            ]),
        )
        .unwrap();
}
#[test]
fn actual_current_binding_lazy_sqlite_dedupe_retired_report_and_missing_db_refusal() {
    let tree = Tree::new();
    let runtime = tree.runtime();
    let telemetry = CommandTelemetry::capture(&runtime, &tree.config()).unwrap();
    let employee = ProfileEmployeeId::parse(E).unwrap();
    let session = ProfileSessionId::parse(S).unwrap();
    assert_eq!(telemetry.report_employee(&employee), EmployeeReport::NoData);
    assert!(!tree.database().exists());
    assert!(telemetry.observe(&session, &event()));
    assert!(telemetry.observe(&session, &event()));
    let Some(report) = telemetry.report(&session) else {
        panic!("actual report")
    };
    assert_eq!(report.counts().len(), 1);
    assert_eq!(report.counts()[0].count(), 1);
    tree.company(true, "owner");
    assert!(!telemetry.observe(&session, &event()));
    assert!(matches!(
        telemetry.report_employee(&employee),
        EmployeeReport::Ready(_)
    ));
    let request = FailureReportRequest::try_new(vec![employee.clone()]).unwrap();
    let report: serde_json::Value =
        serde_json::from_slice(&telemetry.command_failure_report(&request).unwrap()).unwrap();
    assert_eq!(report["employees"][0]["status"], "ready");
    fs::remove_file(tree.database()).unwrap();
    assert_eq!(
        telemetry.report_employee(&employee),
        EmployeeReport::Unavailable
    );
    assert!(!tree.database().exists());
}
#[test]
fn busy_report_reader_refuses_before_storage_and_fifo_or_public_db_is_unavailable() {
    let tree = Tree::new();
    let runtime = tree.runtime();
    let telemetry = CommandTelemetry::capture(&runtime, &tree.config()).unwrap();
    let employee = ProfileEmployeeId::parse(E).unwrap();
    let request = FailureReportRequest::try_new(vec![employee.clone()]).unwrap();
    let held = telemetry.reports.lock().unwrap();
    assert!(telemetry.command_failure_report(&request).is_err());
    drop(held);
    assert!(!tree.database().exists());
    assert!(telemetry.observe(&ProfileSessionId::parse(S).unwrap(), &event()));
    fs::set_permissions(tree.database(), fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        telemetry.report_employee(&employee),
        EmployeeReport::Unavailable
    );
    fs::remove_file(tree.database()).unwrap();
    nix::unistd::mkfifo(
        &tree.database(),
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    assert_eq!(
        telemetry.report_employee(&employee),
        EmployeeReport::Unavailable
    );
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Point {
    FirstBinding,
    LogOpened,
    ReportRead,
    ReportPrechecked,
}
type Hook = Box<dyn FnMut(Point)>;
thread_local! {static HOOK:std::cell::RefCell<Option<Hook>>=std::cell::RefCell::new(None);}
pub(super) fn hit(point: Point) {
    HOOK.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook(point)
        }
    })
}
fn change_owner_at(tree: &Tree, point: Point) {
    let path = tree.0.join("company/employees.json");
    HOOK.with(|hook|*hook.borrow_mut()=Some(Box::new(move|at|{if at==point{fs::write(&path,serde_json::to_vec(&json!({"employees":[{"id":E,"sessionId":S,"owner":"changed","desiredRunning":true}]})).unwrap()).unwrap();}})));
}
#[test]
fn fresh_owner_observations_refuse_producer_before_write_and_reader_before_data_release() {
    let reference: serde_json::Value = serde_json::from_str(include_str!(
        "../../../reverie-contracts/tests/fixtures/command-telemetry/binding-legacy.json"
    ))
    .unwrap();
    for (index, point) in [Point::FirstBinding, Point::LogOpened]
        .into_iter()
        .enumerate()
    {
        let tree = Tree::new();
        let runtime = tree.runtime();
        let telemetry = CommandTelemetry::capture(&runtime, &tree.config()).unwrap();
        change_owner_at(&tree, point);
        assert_eq!(
            telemetry.observe(&ProfileSessionId::parse(S).unwrap(), &event()),
            reference[index]["outcome"].as_bool().unwrap()
        );
        HOOK.with(|hook| *hook.borrow_mut() = None);
        assert_eq!(
            tree.database().exists(),
            reference[index]["database"].as_bool().unwrap()
        );
        if point == Point::LogOpened {
            tree.company(false, "owner");
            let report = telemetry
                .report(&ProfileSessionId::parse(S).unwrap())
                .unwrap();
            assert!(report.counts().is_empty());
        }
    }
    let tree = Tree::new();
    let runtime = tree.runtime();
    let telemetry = CommandTelemetry::capture(&runtime, &tree.config()).unwrap();
    assert!(telemetry.observe(&ProfileSessionId::parse(S).unwrap(), &event()));
    change_owner_at(&tree, Point::ReportRead);
    assert_eq!(
        telemetry.report_employee(&ProfileEmployeeId::parse(E).unwrap()),
        EmployeeReport::Unavailable
    );
    HOOK.with(|hook| *hook.borrow_mut() = None);
}

#[test]
fn disappearing_report_db_after_precheck_is_unavailable_without_empty_recreation() {
    let tree = Tree::new();
    let runtime = tree.runtime();
    let telemetry = CommandTelemetry::capture(&runtime, &tree.config()).unwrap();
    assert!(telemetry.observe(&ProfileSessionId::parse(S).unwrap(), &event()));
    let database = tree.database();
    HOOK.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move |point| {
            if point == Point::ReportPrechecked {
                fs::remove_file(&database).unwrap();
            }
        }))
    });
    let result = telemetry.report_employee(&ProfileEmployeeId::parse(E).unwrap());
    HOOK.with(|hook| *hook.borrow_mut() = None);
    assert_eq!(result, EmployeeReport::Unavailable);
    assert!(!tree.database().exists());
}

#[test]
fn disappearing_report_directory_after_precheck_is_not_initialized_again() {
    let tree = Tree::new();
    let runtime = tree.runtime();
    let telemetry = CommandTelemetry::capture(&runtime, &tree.config()).unwrap();
    assert!(telemetry.observe(&ProfileSessionId::parse(S).unwrap(), &event()));
    let directory = tree.database().parent().unwrap().to_owned();
    let removed = directory.clone();
    HOOK.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move |point| {
            if point == Point::ReportPrechecked {
                fs::remove_dir_all(&removed).unwrap();
            }
        }))
    });
    let result = telemetry.report_employee(&ProfileEmployeeId::parse(E).unwrap());
    HOOK.with(|hook| *hook.borrow_mut() = None);
    assert_eq!(result, EmployeeReport::Unavailable);
    assert!(!directory.exists());
}

#[test]
fn raw_source_type_refusal_stays_after_actual_legacy_directory_enumeration() {
    if native::uid() == 0 {
        return;
    } // root bypasses this owned permission control
    let tree = Tree::new();
    let runtime = tree.runtime();
    let mut raw = tree.raw();
    raw["mounts"] = json!([{"source":7}]);
    fs::set_permissions(tree.0.join("state"), fs::Permissions::from_mode(0o300)).unwrap();
    let result = CommandTelemetry::capture(&runtime, &config(raw));
    fs::set_permissions(tree.0.join("state"), fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        matches!(result,Err(TelemetryError::Io(error))if error.kind()==std::io::ErrorKind::PermissionDenied),
        "source iterates legacy names before canonical(raw source) type refusal"
    );
    assert!(!tree.0.join("calls.txt").exists());
    assert!(!tree.sink().exists());
}
