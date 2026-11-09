use super::*;
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicU64, Ordering};
mod affinity;

static NEXT: AtomicU64 = AtomicU64::new(0);

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "task-cancel-validation-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&dir).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    fs::canonicalize(dir).unwrap()
}
fn write(path: &Path, bytes: &[u8], mode: u32) -> String {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    sha256_hex(bytes)
}

/// A complete synthetic closure: a store owned by this user, a source tree, a
/// controller executable, a private task root and pins naming all of them.
struct World {
    dir: PathBuf,
    pins: Value,
}
impl World {
    fn new() -> Self {
        let dir = scratch();
        let store = dir.join("store");
        let mut tools = Map::new();
        let mut tool_shas = Map::new();
        for name in TOOLS {
            let path = store.join("tools").join(name);
            tool_shas.insert(name.into(), json!(write(&path, name.as_bytes(), 0o555)));
            tools.insert(name.into(), json!(path));
        }
        let hands = store.join("hands");
        let console = store.join("console");
        let consumer = json!({ "zorblat.py": write(&hands.join("zorblat.py"), b"x = 1", 0o444) });
        let modules = json!({ "app/quux.js": write(&console.join("lib/reverie/dist/app/quux.js"), b"1", 0o444) });
        let mut scripts = Map::new();
        for name in FIXTURE_FILES {
            scripts.insert(
                name.into(),
                json!(write(
                    &dir.join("src/scripts/acceptance").join(name),
                    name.as_bytes(),
                    0o644
                )),
            );
        }
        let mut lease = Map::new();
        for name in LEASE_FILES {
            lease.insert(
                name.into(),
                json!(write(&dir.join("src").join(name), name.as_bytes(), 0o644)),
            );
        }
        let controller = write(&dir.join("controller"), b"robotronix controller", 0o755);
        fs::create_dir(dir.join("task")).unwrap();
        fs::set_permissions(dir.join("task"), fs::Permissions::from_mode(0o700)).unwrap();
        let cpus = affinity::selection(&current_affinity().unwrap());
        let pins = json!({
            "operationId": "a".repeat(32),
            "tools": tools, "toolSHA256": tool_shas,
            "scripts": scripts, "controllerSHA256": controller,
            "hands": hands, "consumerModules": consumer,
            "console": console, "consoleModules": modules,
            "leaseFiles": lease, "cpuSet": cpus,
        });
        Self { dir, pins }
    }
    fn inputs(&self, source_only: bool) -> Inputs {
        let raw = serde_json::to_vec(&self.pins).unwrap();
        let path = self.dir.join("pins.json");
        let _ = fs::remove_file(&path);
        let sha = write(&path, &raw, 0o600);
        Inputs {
            pins: path,
            pins_sha256: sha,
            lease_root: self.dir.join("task"),
            source: self.dir.join("src"),
            executable: self.dir.join("controller"),
            closure: Closure {
                store: self.dir.join("store"),
                owner: own_uid().unwrap(),
            },
            source_only,
        }
    }
    fn refused(&self, source_only: bool) -> String {
        validate(&self.inputs(source_only)).unwrap_err()
    }
}

#[test]
fn a_complete_closure_validates() {
    if affinity::isolate_case("validate::tests::a_complete_closure_validates") {
        return;
    }
    let world = World::new();
    let validated = validate(&world.inputs(false)).unwrap();
    assert!(!validated.cpus.is_empty());
    assert_eq!(validated.pins["operationId"], json!("a".repeat(32)));
}

#[test]
fn a_pending_operation_refuses_a_run_but_not_a_source_check() {
    if affinity::isolate_case(
        "validate::tests::a_pending_operation_refuses_a_run_but_not_a_source_check",
    ) {
        return;
    }
    let mut world = World::new();
    world.pins["operationId"] = Value::Null;
    assert!(world.refused(false).contains("operation ID"));
    validate(&world.inputs(true)).unwrap();
}

#[test]
fn changed_or_shared_private_pins_refuse() {
    let world = World::new();
    let mut inputs = world.inputs(false);
    inputs.pins_sha256 = "0".repeat(64);
    assert_eq!(validate(&inputs).unwrap_err(), "private pins changed");
    let inputs = world.inputs(false);
    fs::set_permissions(&inputs.pins, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        validate(&inputs).unwrap_err(),
        "bounded own 0600 metadata required"
    );
}

#[test]
fn read_private_requires_a_canonical_private_unshared_bounded_file() {
    let dir = scratch();
    let file = dir.join("meta.json");
    write(&file, b"{}", 0o600);
    assert_eq!(read_private(&file, 16).unwrap(), b"{}");
    assert!(read_private(Path::new("meta.json"), 16).is_err());
    assert_eq!(
        read_private(&file, 1).unwrap_err(),
        "bounded own 0600 metadata required"
    );
    std::os::unix::fs::symlink(&file, dir.join("link")).unwrap();
    assert_eq!(
        read_private(&dir.join("link"), 16).unwrap_err(),
        "canonical private metadata required"
    );
    fs::hard_link(&file, dir.join("second")).unwrap();
    assert_eq!(
        read_private(&file, 16).unwrap_err(),
        "bounded own 0600 metadata required"
    );
}

#[test]
fn a_writable_moved_or_changed_tool_refuses() {
    let world = World::new();
    let python = PathBuf::from(world.pins["tools"]["python"].as_str().unwrap());
    fs::set_permissions(&python, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(world.refused(false), "immutable tool custody differs");
    fs::set_permissions(&python, fs::Permissions::from_mode(0o444)).unwrap();
    assert_eq!(world.refused(false), "immutable tool custody differs");
    fs::set_permissions(&python, fs::Permissions::from_mode(0o555)).unwrap();
    let mut world = world;
    world.pins["toolSHA256"]["python"] = json!("1".repeat(64));
    assert_eq!(world.refused(false), "immutable closure file bytes differ");
    // The same bytes and mode outside the store.
    let moved = world.dir.join("python");
    world.pins["toolSHA256"]["python"] = json!(write(&moved, b"python", 0o555));
    world.pins["tools"]["python"] = json!(moved);
    assert_eq!(world.refused(false), "immutable tool custody differs");
}

#[test]
fn a_changed_fixture_controller_component_or_lease_source_refuses() {
    let world = World::new();
    fs::write(
        world
            .dir
            .join("src/scripts/acceptance/task-cancel-native.py"),
        b"changed",
    )
    .unwrap();
    assert_eq!(world.refused(false), "reviewed fixture source differs");
    let world = World::new();
    fs::write(world.dir.join("controller"), b"another controller").unwrap();
    assert_eq!(
        world.refused(false),
        "controller executable differs from private pins"
    );
    let mut world = World::new();
    world.pins["consumerModules"] = json!({ "../escape.py": "0".repeat(64) });
    assert_eq!(world.refused(false), "component module path differs");
    // Consumer modules are flat: a nested one refuses even with its pinned bytes.
    let mut world = World::new();
    let nested = world.dir.join("store/hands/nested/zorblat.py");
    world.pins["consumerModules"] = json!({ "nested/zorblat.py": write(&nested, b"x = 1", 0o444) });
    assert_eq!(world.refused(false), "component module path differs");
    let world = World::new();
    fs::write(world.dir.join("src/python/reverie/lease.py"), b"changed").unwrap();
    assert_eq!(world.refused(false), "canonical lease source differs");
}

#[test]
fn a_shared_task_root_refuses() {
    let world = World::new();
    fs::set_permissions(world.dir.join("task"), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(world.refused(false), "private task required");
}

#[test]
fn the_cpu_list_is_private_finite_unique_and_must_cover_the_binding() {
    for good in [json!([0]), json!([1, 3]), json!([0, 1, 2, 3, 4, 5, 6, 7])] {
        assert!(cpu_set(&good).is_ok(), "{good}");
    }
    assert_eq!(cpu_set(&json!([3, 1])).unwrap(), [3, 1]);
    for bad in [
        json!(null),
        json!([]),
        json!([0, 1, 2, 3, 4, 5, 6, 7, 8]),
        json!([-1]),
        json!([1.5]),
        json!([true]),
        json!([false, 1]),
        json!(["0"]),
        json!([1.0]),
        json!([1, 1]),
        json!("0"),
    ] {
        assert!(cpu_set(&bad).is_err(), "{bad}");
    }
    let affinity = current_affinity().unwrap();
    if affinity.len() > 1 {
        let mut world = World::new();
        world.pins["cpuSet"] = json!([affinity.iter().next().unwrap()]);
        assert_eq!(
            world.refused(false),
            "controller CPU binding differs from private pins"
        );
    }
}
