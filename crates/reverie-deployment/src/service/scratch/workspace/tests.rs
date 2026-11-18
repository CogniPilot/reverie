use super::*;
use std::os::unix::fs::{DirBuilderExt, symlink};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().canonicalize().unwrap();
        let mut token = [0u8; 8];
        getrandom::getrandom(&mut token).unwrap();
        let path = base.join(format!("rvw-{:016x}", u64::from_ne_bytes(token)));
        fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        fs::create_dir(path.join("cases")).unwrap();
        Self(path)
    }

    fn cache(&self, relative: &str) -> PathBuf {
        let path = self.0.join("cases").join(relative);
        fs::create_dir_all(path.join("debug")).unwrap();
        fs::write(path.join("CACHEDIR.TAG"), CARGO_TAG).unwrap();
        fs::write(path.join(".rustc_info.json"), "{}").unwrap();
        fs::write(path.join("debug/build"), "generated").unwrap();
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn discovers_only_tagged_case_build_caches_and_honors_protection() {
    let fixture = Fixture::new();
    let accepted = "expert-one/work/checkout/build-custom";
    let work = fixture.cache(accepted);
    fixture.cache("expert-one/sources/project/target");
    let kept = fixture.cache("expert-two/work/keep-project/target");
    fs::write(kept.parent().unwrap().join(".keep"), "unique").unwrap();
    let wrong = fixture.cache("expert-three/work/ordinary-source/target");
    fs::write(wrong.join("CACHEDIR.TAG"), "ordinary file").unwrap();
    let outside = fixture.cache("outside/other/target");
    symlink(outside, work.parent().unwrap().join("external-cache")).unwrap();
    let scope = Scope::open(&fixture.0).unwrap();
    assert_eq!(scope.candidates().unwrap(), vec![PathBuf::from(accepted)]);
    let (parent, _) = scope.locate(Path::new(accepted)).unwrap();
    fs::write(work.parent().unwrap().join(".keep"), "unique").unwrap();
    assert!(scope.check(Path::new(accepted), &parent).is_err());
}

#[test]
fn clears_old_target_only_and_keeps_source_and_recent_outputs() {
    let fixture = Fixture::new();
    let relative = Path::new("expert-one/work/project/target");
    let target = fixture.cache(relative.to_str().unwrap());
    let source = target.parent().unwrap().join("Cargo.toml");
    fs::write(&source, "workspace").unwrap();
    let scope = Scope::open(&fixture.0).unwrap();
    let (parent, name) = scope.locate(relative).unwrap();
    let cache = tree::Cache::observe(&parent, &name).unwrap();
    assert_eq!(cache.row(&target, 0)["status"], "recent");
    assert!(cache.clear(&parent, &name, 0).is_err());
    assert!(target.exists());
    scope.check(relative, &parent).unwrap();
    let report = cache.row(&target, i64::MAX);
    assert_eq!(report["status"], "eligible");
    assert!(report["eligibleBytes"].as_u64().unwrap() > 0);
    cache.clear(&parent, &name, i64::MAX).unwrap();
    assert_eq!(fs::read_to_string(source).unwrap(), "workspace");
    assert!(!target.exists());
}
