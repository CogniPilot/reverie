use super::*;
use std::os::unix::{ffi::OsStringExt, fs::symlink};
use std::{
    ffi::OsString,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "rwvr-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        for name in ["dir", "dir/child"] {
            fs::create_dir(root.join(name)).unwrap();
        }
        fs::write(root.join("file"), b"owned").unwrap();
        let byte = root.join(OsString::from_vec(b"byte-\xc2\x80".to_vec()));
        fs::create_dir(&byte).unwrap();
        fs::create_dir(byte.join("inside")).unwrap();
        symlink("inside", byte.join("relative")).unwrap();
        symlink(byte.join("inside"), byte.join("absolute")).unwrap();
        for (name, target) in [
            ("alias", "dir"),
            ("dangling", "missing"),
            ("loop", "loop"),
            ("file-dot", "file/."),
            ("file-slash", "file/"),
            ("file-parent", "file/.."),
        ] {
            symlink(target, root.join(name)).unwrap();
        }
        Self(root)
    }
    fn substitute(&self, raw: &[u32]) -> Vec<u32> {
        let mut output = raw.to_vec();
        for (token, path) in [
            ("$ROOT", self.0.clone()),
            (
                "$CWD_PARENT",
                std::env::current_dir()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .to_owned(),
            ),
            ("$CWD", std::env::current_dir().unwrap()),
        ] {
            let token = token.bytes().map(u32::from).collect::<Vec<_>>();
            let replacement = python_text(&path);
            while let Some(start) = output.windows(token.len()).position(|v| v == token) {
                output.splice(start..start + token.len(), replacement.iter().copied());
            }
        }
        output
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn optional_resolution_matches_python_errors_missing_tails_and_string_provenance() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/worker_validation/resolve.json"
    ))
    .unwrap();
    let tree = Tree::new();
    assert_eq!(cases.as_array().unwrap().len(), 25);
    for case in cases.as_array().unwrap() {
        let input: Vec<u32> = serde_json::from_value(case["input"].clone()).unwrap();
        let input = tree.substitute(&input);
        let result = resolve_optional_text(&input);
        if case["expected"].is_null() {
            assert!(result.is_err(), "{input:?}");
        } else {
            let expected: Vec<u32> = serde_json::from_value(case["expected"].clone()).unwrap();
            assert_eq!(
                result.unwrap().codepoints(),
                tree.substitute(&expected),
                "{input:?}"
            );
        }
    }
}
#[test]
fn future_sources_follow_dangling_aliases_but_refuse_nonabsence_errors() {
    let tree = Tree::new();
    let resolve = |suffix: &str| resolve_future_text(&python_text(&tree.0.join(suffix)));
    assert_eq!(
        resolve("dangling/tail").unwrap().codepoints(),
        python_text(&tree.0.join("missing/tail"))
    );
    for suffix in ["file/child", "file-slash/child"] {
        assert_eq!(
            resolve(suffix).unwrap_err().raw_os_error(),
            Some(libc::ENOTDIR)
        );
    }
    assert_eq!(
        resolve("loop/child").unwrap_err().raw_os_error(),
        Some(libc::ELOOP)
    );
    assert!(resolve_strict_text(&python_text(&tree.0.join("dangling/tail"))).is_err());
    if nix::unistd::geteuid().as_raw() != 0 {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(tree.0.join("dir"), fs::Permissions::from_mode(0)).unwrap();
        let denied = resolve("dir/child/future");
        fs::set_permissions(tree.0.join("dir"), fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(denied.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    }
}
