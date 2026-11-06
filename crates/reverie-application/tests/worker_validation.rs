use reverie_application::worker_validation::{
    WorkerValidationCause, load_owner_config, validate_captured,
};
use reverie_contracts::worker_config;
use reverie_host::worker_mounts::WorkerMountError;
use serde::Deserialize;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Deserialize)]
struct File {
    path: String,
    raw: String,
    mode: u32,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    raw: String,
    accepted: bool,
    expected: Option<String>,
}
#[derive(Deserialize)]
struct Corpus {
    files: Vec<File>,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoaderCase {
    name: String,
    raw_hex: String,
    mode: u32,
    accepted: bool,
    expected: Option<String>,
    before_validation: Option<bool>,
}
static NEXT: AtomicU64 = AtomicU64::new(0);
fn bytes(raw: &str) -> Vec<u8> {
    assert!(raw.len().is_multiple_of(2));
    raw.as_bytes()
        .chunks_exact(2)
        .map(|part| u8::from_str_radix(std::str::from_utf8(part).unwrap(), 16).unwrap())
        .collect()
}
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        // OPS explicitly refuses writable ancestors such as /tmp. Exercise the
        // actual boundary beneath the test user's home; never chmod an existing
        // ancestor or read company/installed configuration.
        let root = PathBuf::from(std::env::var_os("HOME").expect("owned test home")).join(format!(
            ".reverie-validation-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        for name in [
            "work",
            "private",
            "private/state",
            "private/socket",
            "private/engine",
            "lease",
            "workspace",
            "workspace/attachments",
        ] {
            fs::create_dir(root.join(name)).unwrap();
            fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::write(root.join("file"), b"owned").unwrap();
        symlink("lease", root.join("alias")).unwrap();
        symlink("loop", root.join("loop")).unwrap();
        Self(root)
    }
    fn substitute(&self, raw: &str) -> String {
        raw.replace("$ROOT", &self.json_interior())
    }
    fn json_interior(&self) -> String {
        let path = serde_json::to_string(self.0.to_str().unwrap()).unwrap();
        path[1..path.len() - 1].to_owned()
    }
}

#[test]
fn real_owner_loader_matches_python_text_duplicates_limits_and_encoding() {
    let cases: Vec<LoaderCase> =
        serde_json::from_str(include_str!("fixtures/worker_validation/loader.json")).unwrap();
    assert_eq!(cases.len(), 35);
    let tree = Tree::new();
    let config_path = tree.0.join("owner-config.json");
    for case in cases {
        let mut raw = bytes(&case.raw_hex);
        let replacement = tree.json_interior();
        while let Some(start) = raw.windows(5).position(|v| v == b"$ROOT") {
            raw.splice(start..start + 5, replacement.as_bytes().iter().copied());
        }
        fs::write(&config_path, raw).unwrap();
        fs::set_permissions(&config_path, fs::Permissions::from_mode(case.mode)).unwrap();
        let result = load_owner_config(&config_path);
        assert_eq!(
            result.is_ok(),
            case.accepted,
            "{}: {:?}",
            case.name,
            result.as_ref().err()
        );
        if case.before_validation == Some(true) {
            assert_eq!(
                result.as_ref().err().unwrap().stage(),
                reverie_application::worker_validation::WorkerValidationStage::Loader,
                "{}",
                case.name
            );
        }
        if let Ok(result) = result {
            assert_eq!(
                worker_config::encode_config(result.configuration()),
                tree.substitute(case.expected.as_ref().unwrap()).as_bytes(),
                "{}",
                case.name
            );
        }
    }
}

#[test]
fn paired_failures_preserve_source_phase_and_per_mount_native_order() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/worker_validation/order.json")).unwrap();
    let tree = Tree::new();
    assert_eq!(cases.as_array().unwrap().len(), 22);
    for case in cases.as_array().unwrap() {
        let raw = tree.substitute(case["raw"].as_str().unwrap());
        let error = validate_captured(worker_config::decode(raw.as_bytes()).unwrap())
            .err()
            .unwrap();
        assert_eq!(
            format!("{:?}", error.stage()),
            case["stage"].as_str().unwrap(),
            "{}",
            case["error"]
        );
        if case["stage"] == "BaseMounts"
            && case["error"]
                .as_str()
                .unwrap()
                .starts_with("FileNotFoundError")
        {
            assert!(
                matches!(
                    error.cause(),
                    WorkerValidationCause::Mount(WorkerMountError::Io(_))
                ),
                "earlier source resolution must precede the next malformed declaration"
            );
        }
        if case["stage"] == "Rootless"
            && case["error"]
                .as_str()
                .unwrap()
                .starts_with("FileNotFoundError")
        {
            assert!(
                matches!(
                    error.cause(),
                    WorkerValidationCause::Rootless(
                        reverie_host::rootless::RootlessHostError::Observation(_)
                    )
                ),
                "empty resource maps must not preempt the actual rootless profile observation"
            );
        }
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn full_ordered_validator_matches_actual_python_optional_and_native_cases() {
    let corpus: Corpus =
        serde_json::from_str(include_str!("fixtures/worker_validation/legacy.json")).unwrap();
    assert_eq!(corpus.cases.len(), 166);
    let tree = Tree::new();
    for file in corpus.files {
        let path = tree.0.join(file.path);
        fs::write(&path, tree.substitute(&file.raw)).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(file.mode)).unwrap();
    }
    for case in corpus.cases {
        let config = worker_config::decode(tree.substitute(&case.raw).as_bytes()).unwrap();
        let result = validate_captured(config);
        assert_eq!(
            result.is_ok(),
            case.accepted,
            "{}: {:?}",
            case.name,
            result.as_ref().err()
        );
        if let Ok(result) = result {
            assert_eq!(
                worker_config::encode_config(result.configuration()),
                tree.substitute(case.expected.as_ref().unwrap()).as_bytes(),
                "{}",
                case.name
            );
        }
    }
}
