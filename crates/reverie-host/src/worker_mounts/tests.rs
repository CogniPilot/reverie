use super::*;
use reverie_contracts::worker_config;
use std::ffi::OsString;
use std::os::unix::{
    ffi::OsStringExt,
    fs::{PermissionsExt, symlink},
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
static NEXT: AtomicU64 = AtomicU64::new(0);

const LONGEST_SOCKET_SUFFIX: &str = "control/../control/broker.sock";
fn fixture_root(preferred: &Path) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let name = format!(
        "rwm-{}-{nonce:x}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    // These Linux-native fixtures exercise a real legacy socket spelling cap.
    // A long TMPDIR must not make otherwise valid mount cases fail the header.
    for parent in [preferred, Path::new("/tmp")] {
        let Ok(parent) = fs::canonicalize(parent) else {
            continue;
        };
        let root = parent.join(&name);
        if root
            .join(LONGEST_SOCKET_SUFFIX)
            .to_str()
            .is_some_and(|text| text.len() <= 100 && !text.contains([',', '\r', '\n', '\0']))
        {
            return root;
        }
    }
    panic!("worker mount fixtures require a short canonical temporary directory");
}

struct Tree {
    root: PathBuf,
}
impl Tree {
    fn new() -> Self {
        let root = fixture_root(&std::env::temp_dir());
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        for name in [
            "source",
            "control",
            "state",
            "state/child",
            "other",
            "workspace",
            "workspace/attachments",
            "outside",
            "workspace-file-attachment",
            "workspace-symlink-attachment",
            "workspace-missing-attachment",
            "other-workspace",
            "other-workspace/attachments",
            "é-😀",
        ] {
            fs::create_dir(root.join(name)).unwrap();
        }
        fs::create_dir(root.join(OsString::from_vec(b"raw-\xff".to_vec()))).unwrap();
        for name in [
            "file-source",
            "control/broker.sock",
            "workspace/attachments/file",
            "workspace-file-attachment/attachments",
        ] {
            fs::write(root.join(name), b"synthetic").unwrap();
        }
        for (link, target) in [
            ("source-alias", "source"),
            ("state-alias", "state"),
            ("workspace-alias", "workspace"),
            ("attachment-alias", "workspace/attachments"),
            ("workspace-symlink-attachment/attachments", "outside"),
            ("workspace/attachments/escape", "outside"),
            ("dangling", "missing"),
        ] {
            symlink(root.join(target), root.join(link)).unwrap();
        }
        Self { root }
    }
    fn substitute(&self, raw: &str) -> String {
        let escaped = serde_json::to_string(self.root.to_str().unwrap()).unwrap();
        raw.replace("$ROOT", &escaped[1..escaped.len() - 1])
    }
    fn provenance(&self) {
        let directory = self
            .root
            .join(OsString::from_vec(b"byte-\xc2\x80".to_vec()));
        fs::create_dir(&directory).unwrap();
        for name in ["inside", "attachments"] {
            fs::create_dir(directory.join(name)).unwrap();
        }
        symlink("inside", directory.join("relative")).unwrap();
        symlink(directory.join("inside"), directory.join("absolute")).unwrap();
        for (link, target) in [
            ("loop", "loop"),
            ("file-dot", "file-source/."),
            ("file-trailing", "file-source/"),
            ("file-parent", "file-source/.."),
            ("dir-parent", "source/../other"),
        ] {
            symlink(target, self.root.join(link)).unwrap();
        }
        for i in 0..100 {
            let target = if i == 99 {
                "source".into()
            } else {
                format!("chain-{}", i + 1)
            };
            symlink(target, self.root.join(format!("chain-{i}"))).unwrap();
        }
    }
    fn expected(&self, raw: &serde_json::Value) -> Vec<u32> {
        let points: Vec<u32> = raw
            .as_array()
            .unwrap()
            .iter()
            .map(|n| u32::try_from(n.as_u64().unwrap()).unwrap())
            .collect();
        let prefix: Vec<u32> = "$ROOT".chars().map(u32::from).collect();
        assert!(points.starts_with(&prefix));
        let mut result = native::python_text(&self.root);
        result.extend_from_slice(&points[prefix.len()..]);
        result
    }
}

#[test]
fn long_temporary_parent_keeps_native_fixture_socket_spelling_valid() {
    let tree = Tree::new();
    let long = tree.root.join("x".repeat(150));
    fs::create_dir(&long).unwrap();
    let selected = fixture_root(&long);
    assert!(selected.join(LONGEST_SOCKET_SUFFIX).to_str().unwrap().len() <= 100);
    assert_eq!(
        selected.parent().unwrap(),
        fs::canonicalize("/tmp").unwrap()
    );
    assert!(
        !selected.exists(),
        "path selection must not adopt existing fixture data"
    );
}

#[test]
fn native_fixture_root_is_escaped_when_inserted_into_json_strings() {
    let parent = Tree::new();
    let quoted = Tree {
        root: parent.root.join("quoted\"\\name"),
    };
    fs::create_dir(&quoted.root).unwrap();
    let raw = quoted.substitute(r#"{"path":"$ROOT/source"}"#);
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        parsed["path"].as_str().unwrap(),
        quoted.root.join("source").to_str().unwrap()
    );
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn actual_python_native_mount_sources_and_attachment_aliases_match() {
    check_corpus(
        include_str!("../../tests/fixtures/worker-mount-sources-python.json"),
        38,
        10,
        false,
    );
}
#[test]
fn python_resolved_string_provenance_and_strict_symlink_rules_are_preserved() {
    check_corpus(
        include_str!("../../tests/fixtures/worker-mount-provenance-python.json"),
        20,
        3,
        true,
    );
}
fn check_corpus(raw: &str, count: usize, min_accepted: usize, provenance: bool) {
    let corpus: serde_json::Value = serde_json::from_str(raw).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), count);
    let mut accepted = 0;
    for case in cases {
        let tree = Tree::new();
        if provenance {
            tree.provenance();
        }
        let raw = tree.substitute(case["raw"].as_str().unwrap());
        let config = worker_config::decode(raw.as_bytes()).unwrap();
        let envelope = WorkerEnvelope::capture(config).unwrap();
        let before = worker_config::encode_config(envelope.configuration());
        let result = observe_mount_sources(&envelope);
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        if let Ok(result) = result {
            accepted += 1;
            let expected = case["resolved"].as_array().unwrap();
            assert_eq!(result.mounts().len(), expected.len());
            for (mount, expected) in result.mounts().iter().zip(expected) {
                assert_eq!(
                    mount.resolved_path_text().codepoints(),
                    tree.expected(expected),
                    "{}",
                    case["name"]
                );
            }
        }
        assert_eq!(
            worker_config::encode_config(envelope.configuration()),
            before
        );
    }
    assert!(
        accepted > min_accepted,
        "oracle must exercise actual accepted observations"
    );
}
