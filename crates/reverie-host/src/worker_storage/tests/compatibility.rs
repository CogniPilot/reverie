use super::*;

fn substitute(value: &mut Value, root: &Path) {
    match value {
        Value::String(value) => *value = value.replace("$ROOT", root.to_str().unwrap()),
        Value::Array(values) => values.iter_mut().for_each(|v| substitute(v, root)),
        Value::Object(values) => values.values_mut().for_each(|v| substitute(v, root)),
        _ => {}
    }
}
fn setup(tree: &Tree, case: &Value) {
    tree.write(
        &tree.0.join("company.json"),
        case["company_text"].as_str().unwrap().as_bytes(),
    );
    if let Some(rows) = case["setup"].as_array() {
        for row in rows {
            setup_entry(tree, row);
        }
    }
    if let Some(journal) = case["journal_text"].as_str() {
        tree.write(&tree.0.join("plan-moves.json"), journal.as_bytes());
    }
}
fn setup_entry(tree: &Tree, row: &Value) {
    let path = tree.0.join(row["path"].as_str().unwrap());
    if row["kind"] == "dir" {
        tree.mkdir(&path);
        stdfs::set_permissions(
            &path,
            stdfs::Permissions::from_mode(row["mode"].as_u64().unwrap() as u32),
        )
        .unwrap();
        return;
    }
    tree.mkdir(path.parent().unwrap());
    if row["kind"] == "file" {
        tree.write(&path, row["text"].as_str().unwrap().as_bytes());
    } else {
        symlink(
            row["target"]
                .as_str()
                .unwrap()
                .replace("$ROOT", tree.0.to_str().unwrap()),
            &path,
        )
        .unwrap();
    }
}
fn snapshot(root: &Path, parent: &Path, result: &mut Vec<Value>) -> std::io::Result<()> {
    let mut entries = stdfs::read_dir(parent)?
        .map(|v| v.unwrap().path())
        .collect::<Vec<_>>();
    entries.sort();
    for path in entries {
        let info = stdfs::symlink_metadata(&path)?;
        let mut row = json!({"path":path.strip_prefix(root).unwrap(),"mode":info.mode() & 0o777});
        let mut child = Vec::new();
        if info.file_type().is_symlink() {
            row["kind"] = json!("link");
            row["target"] = json!(
                stdfs::read_link(&path)?
                    .to_str()
                    .unwrap()
                    .replace(root.to_str().unwrap(), "$ROOT")
            );
        } else if info.is_dir() {
            row["kind"] = json!("dir");
            match snapshot(root, &path, &mut child) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                    row["unreadable"] = json!(true)
                }
                Err(e) => return Err(e),
            }
        } else {
            row["kind"] = json!("file");
            row["text"] = json!(stdfs::read_to_string(&path)?);
        }
        result.push(row);
        result.extend(child);
    }
    Ok(())
}
fn run(tree: &Tree, case: &Value) -> Result<()> {
    let mut raw = tree.raw();
    if let Some(values) = case["config"].as_object() {
        for (k, v) in values {
            raw[k] = v.clone();
        }
    }
    substitute(&mut raw, &tree.0);
    let source = config(raw);
    let sid = session(case["session"].as_str().unwrap_or(A));
    let mut lease = if case["migration"] == true {
        StorageLease::acquire_migration(&source, &sid)?
    } else {
        StorageLease::acquire_launch(&source, &sid)?
    };
    let result = (|| {
        for step in case["steps"].as_array().unwrap() {
            match step.as_str().unwrap() {
                "prepare" => lease.prepare_storage()?,
                "record" => lease.record_storage_binding()?,
                "validate" => validate_storage(&source, lease.paths())?,
                _ => unreachable!(),
            }
        }
        Ok(())
    })();
    finalized(result, lease.close())
}
fn restore_test_permissions(path: &Path) {
    if stdfs::symlink_metadata(path).unwrap().is_dir() {
        stdfs::set_permissions(path, stdfs::Permissions::from_mode(0o700)).unwrap();
        for child in stdfs::read_dir(path).unwrap() {
            restore_test_permissions(&child.unwrap().path());
        }
    }
}
#[test]
fn actual_python_complete_storage_actions_match_results_bytes_modes_and_retained_effects() {
    let corpus: Value = serde_json::from_str(include_str!("../fixtures/legacy.json")).unwrap();
    assert_eq!(corpus["cases"].as_array().unwrap().len(), 58);
    for case in corpus["cases"].as_array().unwrap() {
        let tree = Tree::new();
        setup(&tree, case);
        let outcome = run(&tree, case);
        assert_eq!(
            outcome.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}: {outcome:?}",
            case["name"]
        );
        let mut actual = Vec::new();
        snapshot(&tree.0, &tree.0, &mut actual).unwrap();
        restore_test_permissions(&tree.0);
        assert_eq!(Value::Array(actual), case["snapshot"], "{}", case["name"]);
    }
}
