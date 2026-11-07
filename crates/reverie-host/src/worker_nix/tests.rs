use super::*;
use reverie_contracts::worker_config;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};
const SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "nix-store-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    fn config(&self) -> Value {
        json!({"uid":native::uid(),"gid":fs::metadata(&self.0).unwrap().gid(),"stateRoot":self.0.join("state"),"scratchRoot":self.0.join("scratch"),"companyFile":self.0.join("company.json"),"deployment":"fixture","image":format!("sha256:{}","0".repeat(64)),"budgetMode":"session","cgroupParent":"fixture.slice","mounts":[]})
    }
    fn mkdir(&self, path: &Path) {
        fs::create_dir_all(path).unwrap();
        let mut current = path;
        while current.starts_with(&self.0) {
            fs::set_permissions(current, fs::Permissions::from_mode(0o700)).unwrap();
            let Some(parent) = current.parent() else {
                break;
            };
            current = parent;
        }
    }
    fn write(&self, path: &Path, text: &str, mode: u32) {
        fs::write(path, text).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }
}
fn restore(path: &Path) {
    if fs::symlink_metadata(path).unwrap().is_dir() {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        for child in fs::read_dir(path).unwrap() {
            restore(&child.unwrap().path());
        }
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        restore(&self.0);
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn config(raw: &Value) -> EffectiveWorkerConfig {
    worker_config::decode(&serde_json::to_vec(raw).unwrap()).unwrap()
}
fn sid() -> ProfileSessionId {
    ProfileSessionId::parse(SID).unwrap()
}
fn substitute(value: &mut Value, root: &Path) {
    match value {
        Value::String(v) => *v = v.replace("$ROOT", root.to_str().unwrap()),
        Value::Array(v) => v.iter_mut().for_each(|v| substitute(v, root)),
        Value::Object(v) => v.values_mut().for_each(|v| substitute(v, root)),
        _ => {}
    }
}
fn setup_entry(tree: &Tree, row: &Value) {
    let path = tree.0.join(row["path"].as_str().unwrap());
    if row["kind"] == "dir" {
        tree.mkdir(&path);
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(row["mode"].as_u64().unwrap() as u32),
        )
        .unwrap();
        return;
    }
    tree.mkdir(path.parent().unwrap());
    match row["kind"].as_str().unwrap() {
        "file" => tree.write(
            &path,
            row["text"].as_str().unwrap(),
            row["mode"].as_u64().unwrap() as u32,
        ),
        "link" => symlink(
            row["target"]
                .as_str()
                .unwrap()
                .replace("$ROOT", tree.0.to_str().unwrap()),
            path,
        )
        .unwrap(),
        "hardlink" => fs::hard_link(tree.0.join(row["target"].as_str().unwrap()), path).unwrap(),
        _ => unreachable!(),
    }
}
fn snapshot(root: &Path, parent: &Path, result: &mut Vec<Value>) -> std::io::Result<()> {
    let mut entries = fs::read_dir(parent)?
        .map(|v| v.unwrap().path())
        .collect::<Vec<_>>();
    entries.sort();
    for path in entries {
        let info = fs::symlink_metadata(&path)?;
        let mut row = json!({"path":path.strip_prefix(root).unwrap(),"mode":info.mode()&0o777,"links":if info.is_file(){info.nlink()}else{0}});
        let mut children = Vec::new();
        if info.file_type().is_symlink() {
            row["kind"] = json!("link");
            row["target"] = json!(
                fs::read_link(&path)?
                    .to_str()
                    .unwrap()
                    .replace(root.to_str().unwrap(), "$ROOT")
            );
        } else if info.is_dir() {
            row["kind"] = json!("dir");
            match snapshot(root, &path, &mut children) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                    row["unreadable"] = json!(true)
                }
                Err(e) => return Err(e),
            }
        } else {
            row["kind"] = json!("file");
            row["text"] = json!(fs::read_to_string(&path)?);
        }
        result.push(row);
        result.extend(children);
    }
    Ok(())
}
fn run(
    tree: &Tree,
    source: &EffectiveWorkerConfig,
    case: &Value,
    observed: &mut Vec<Value>,
) -> Result<()> {
    let mut guard = if case["migration"] == true {
        NixStoreGuard::acquire_migration(source, &sid())?
    } else {
        NixStoreGuard::acquire_launch(source, &sid())?
    };
    let result = (|| {
        let mut selected = None;
        for step in case["steps"].as_array().unwrap() {
            if step == "private" {
                let path = guard.prepare_private_store(source)?;
                observed.push(json!({"path":path.to_str().unwrap().replace(tree.0.to_str().unwrap(),"$ROOT")}));
                selected = Some(path);
            } else {
                let args = guard.preparation_arguments(source, selected.as_ref().unwrap())?;
                let arguments = normalized_arguments(tree, &args);
                observed.push(json!({"name":args.name().scalar_text().unwrap(),"args":arguments}));
            }
        }
        Ok(())
    })();
    finalized(result, guard.close())
}
fn normalized_arguments(tree: &Tree, args: &NixPreparationArguments) -> Vec<String> {
    let raw = tree.config();
    let user = format!("{}:{}", raw["uid"], raw["gid"]);
    args.arguments()
        .iter()
        .map(|v| {
            v.scalar_text()
                .unwrap()
                .replace(tree.0.to_str().unwrap(), "$ROOT")
                .replace(&user, "$UID:$GID")
        })
        .collect()
}
#[test]
fn actual_python_store_guard_private_selection_and_fixed_arguments_preserve_retained_tree() {
    let corpus: Value = serde_json::from_str(include_str!("fixtures/legacy.json")).unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let tree = Tree::new();
        let mut raw = tree.config();
        if let Some(values) = case["config"].as_object() {
            for (name, value) in values {
                raw[name] = value.clone();
            }
        }
        substitute(&mut raw, &tree.0);
        let source = config(&raw);
        tree.write(
            &tree.0.join("company.json"),
            case["company_text"].as_str().unwrap(),
            0o600,
        );
        if case["employee"] == true {
            let mut storage =
                crate::worker_storage::StorageLease::acquire_launch(&source, &sid()).unwrap();
            storage.prepare_storage().unwrap();
            storage.record_storage_binding().unwrap();
            storage.close().unwrap();
        }
        if let Some(rows) = case["setup"].as_array() {
            for row in rows {
                setup_entry(&tree, row);
            }
        }
        let mut observed = Vec::new();
        let outcome = run(&tree, &source, case, &mut observed);
        assert_eq!(
            outcome.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{} {outcome:?}",
            case["name"]
        );
        assert_eq!(Value::Array(observed), case["results"], "{}", case["name"]);
        let mut captured = Vec::new();
        snapshot(&tree.0, &tree.0, &mut captured).unwrap();
        restore(&tree.0);
        assert_eq!(Value::Array(captured), case["snapshot"], "{}", case["name"]);
    }
}
#[test]
fn projected_resources_and_mounts_are_used_after_raw_guard_acquisition() {
    let cases: Value = serde_json::from_str(include_str!("fixtures/prepared.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let tree = Tree::new();
        tree.write(&tree.0.join("company.json"), "{\"employees\":[]}", 0o600);
        let mut raw = tree.config();
        raw["budgetMode"] = case["raw_mode"].clone();
        raw["cgroupParent"] = json!("raw.slice");
        let mut guard = NixStoreGuard::acquire_launch(&config(&raw), &sid()).unwrap();
        let mut prepared = raw.clone();
        for (k, v) in case["prepared"].as_object().unwrap() {
            prepared[k] = v.clone();
        }
        substitute(&mut prepared, &tree.0);
        let source = config(&prepared);
        let path = guard.prepare_private_store(&source).unwrap();
        let args = guard.preparation_arguments(&source, &path).unwrap();
        let user = format!("{}:{}", raw["uid"], raw["gid"]);
        let actual = args
            .arguments()
            .iter()
            .map(|v| {
                v.scalar_text()
                    .unwrap()
                    .replace(tree.0.to_str().unwrap(), "$ROOT")
                    .replace(&user, "$UID:$GID")
            })
            .collect::<Vec<_>>();
        assert_eq!(json!(actual), case["args"]);
        assert_eq!(
            args.name().scalar_text().unwrap(),
            case["name"].as_str().unwrap()
        );
        guard.close().unwrap();
    }
}
#[test]
fn prepared_data_cannot_redirect_the_actual_held_store_namespace() {
    let tree = Tree::new();
    tree.write(&tree.0.join("company.json"), "{\"employees\":[]}", 0o600);
    let raw = tree.config();
    let mut guard = NixStoreGuard::acquire_launch(&config(&raw), &sid()).unwrap();
    let mut different = raw.clone();
    different["stateRoot"] = json!(tree.0.join("foreign-state"));
    assert!(guard.prepare_private_store(&config(&different)).is_err());
    assert!(!tree.0.join("foreign-state").exists());
    guard.close().unwrap();
}
