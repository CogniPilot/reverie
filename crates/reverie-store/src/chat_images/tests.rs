use super::*;
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nowned-image";
struct Fixture {
    base: PathBuf,
    state: PathBuf,
    cache: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!(
            "image-custody-{}",
            crate::private_fs::random_uuid().unwrap()
        ));
        fs::create_dir(&base).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        let state = base.join("state");
        let cache = base.join("cache");
        for path in [&state, &cache] {
            fs::create_dir(path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self { base, state, cache }
    }
    fn open(&self) -> ImageCache {
        ImageCache::open(&self.state, &self.cache)
            .ok()
            .expect("owned cache")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.base).unwrap();
    }
}
#[test]
fn installed_bytes_roundtrip_expire_and_restart_recovery() {
    let fixture = Fixture::new();
    let mut cache = fixture.open();
    let now = Instant::now();
    let copy = cache.install(PNG, now).unwrap();
    assert_eq!(
        fs::read(fixture.cache.join(copy.name().as_str())).unwrap(),
        PNG
    );
    assert_eq!(cache.verify_copies(&[copy], now).unwrap(), [1800]);
    assert_eq!(
        ImageCache::open(&fixture.state, &fixture.cache)
            .err()
            .unwrap()
            .error
            .code(),
        "custody_busy"
    );
    cache.retire().unwrap();
    let mut recovered = fixture.open();
    assert!(fs::read_dir(&fixture.cache).unwrap().next().is_none());
    let copy = recovered.install(PNG, now).unwrap();
    recovered.expire(now + Duration::from_secs(1800)).unwrap();
    assert!(!fixture.cache.join(copy.name().as_str()).exists());
    recovered
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
}
#[test]
fn whole_record_is_validated_before_any_restart_deletion() {
    let fixture = Fixture::new();
    let mut cache = fixture.open();
    let first = cache.install(PNG, Instant::now()).unwrap();
    let second = cache.install(PNG, Instant::now()).unwrap();
    cache.retire().unwrap();
    let path = fixture.cache.join(second.name().as_str());
    fs::write(&path, b"modified bytes").unwrap();
    assert!(ImageCache::open(&fixture.state, &fixture.cache).is_err());
    assert_eq!(
        fs::read(fixture.cache.join(first.name().as_str())).unwrap(),
        PNG
    );
    assert_eq!(fs::read(path).unwrap(), b"modified bytes");
}
#[test]
fn unknown_and_hardlinked_files_are_preserved() {
    let fixture = Fixture::new();
    let mut cache = fixture.open();
    let copy = cache.install(PNG, Instant::now()).unwrap();
    cache.retire().unwrap();
    let foreign = fixture.cache.join("foreign");
    fs::write(&foreign, b"foreign").unwrap();
    let error = ImageCache::open(&fixture.state, &fixture.cache)
        .err()
        .unwrap();
    assert_eq!(error.error.code(), "cache_not_empty");
    assert!(fixture.cache.join(copy.name().as_str()).exists());
    fs::remove_file(&foreign).unwrap();
    fs::hard_link(fixture.cache.join(copy.name().as_str()), &foreign).unwrap();
    assert!(ImageCache::open(&fixture.state, &fixture.cache).is_err());
    assert_eq!(fs::read(&foreign).unwrap(), PNG);
}
#[test]
fn changed_cache_retains_old_raw_ledger_without_chasing_old_bytes() {
    let fixture = Fixture::new();
    let mut cache = fixture.open();
    let copy = cache.install(PNG, Instant::now()).unwrap();
    cache.retire().unwrap();
    let old = fixture.base.join("old-cache");
    let raw = fs::read(fixture.state.join(custody::NAME)).unwrap();
    fs::rename(&fixture.cache, &old).unwrap();
    fs::create_dir(&fixture.cache).unwrap();
    fs::set_permissions(&fixture.cache, fs::Permissions::from_mode(0o700)).unwrap();
    let mut changed = fixture.open();
    let retained = fs::read_dir(&fixture.state)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .as_encoded_bytes()
                .starts_with(b".chat-image-custody-retained-")
        })
        .unwrap();
    assert_eq!(fs::read(retained).unwrap(), raw);
    assert_eq!(fs::read(old.join(copy.name().as_str())).unwrap(), PNG);
    changed
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
}
#[test]
fn failed_actual_file_finalization_fences_further_ready() {
    let fixture = Fixture::new();
    let mut cache = fixture.open();
    crate::faults::STATE
        .with(|state| state.borrow_mut().close = Some(crate::private_fs::CloseRole::Data));
    assert!(
        cache
            .install(PNG, Instant::now())
            .err()
            .unwrap()
            .is_uncertain()
    );
    crate::faults::reset();
    assert_eq!(
        cache.begin(Instant::now()).err().unwrap().code(),
        "cache_unavailable"
    );
    assert!(cache.retire().err().unwrap().is_uncertain());
}
#[test]
fn retired_owner_is_terminal_and_repeated_known_close_preserves_bytes() {
    let fixture = Fixture::new();
    let mut cache = fixture.open();
    let copy = cache.install(PNG, Instant::now()).unwrap();
    let ledger = fs::read(fixture.state.join(custody::NAME)).unwrap();
    cache.retire().unwrap();
    cache.close(Instant::now()).unwrap();
    cache.retire().unwrap();
    cache.close(Instant::now()).unwrap();
    assert_eq!(
        cache.rollback(&[copy]).err().unwrap().code(),
        "cache_unavailable"
    );
    assert_eq!(fs::read(fixture.state.join(custody::NAME)).unwrap(), ledger);
    assert_eq!(fs::read_dir(&fixture.cache).unwrap().count(), 1);
}
#[test]
fn consumed_close_uncertainty_never_becomes_success_on_retry() {
    for role in [
        crate::private_fs::CloseRole::Lock,
        crate::private_fs::CloseRole::Store,
    ] {
        let fixture = Fixture::new();
        let mut cache = fixture.open();
        crate::faults::STATE.with(|state| state.borrow_mut().close = Some(role));
        assert!(cache.retire().is_err());
        crate::faults::reset();
        assert_eq!(cache.retire().err().unwrap().code(), "custody_unconfirmed");
        assert_eq!(
            cache
                .close(Instant::now() + Duration::from_secs(2))
                .err()
                .unwrap()
                .code(),
            "custody_unconfirmed"
        );
    }
}
#[test]
fn ledger_entry_order_remains_original_insertion_order() {
    let fixture = Fixture::new();
    let mut cache = fixture.open();
    let copies = (0..8)
        .map(|_| cache.install(PNG, Instant::now()).unwrap())
        .collect::<Vec<_>>();
    let raw = fs::read(fixture.state.join(custody::NAME)).unwrap();
    let ledger = reverie_contracts::chat_images::decode_ledger(&raw).unwrap();
    assert_eq!(
        ledger
            .entries()
            .iter()
            .map(|entry| entry.name())
            .collect::<Vec<_>>(),
        copies.iter().map(|copy| copy.name()).collect::<Vec<_>>()
    );
    cache
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
}
#[test]
fn failed_constructor_close_returns_sticky_actual_owner() {
    let fixture = Fixture::new();
    fs::write(fixture.cache.join("unknown"), b"preserved").unwrap();
    crate::faults::STATE
        .with(|state| state.borrow_mut().close = Some(crate::private_fs::CloseRole::Lock));
    let failure = ImageCache::open(&fixture.state, &fixture.cache)
        .err()
        .unwrap();
    crate::faults::reset();
    let mut retained = failure.retained.expect("actual failed finalizer owner");
    assert_eq!(
        retained.retire().err().unwrap().code(),
        "custody_unconfirmed"
    );
    assert_eq!(
        fs::read(fixture.cache.join("unknown")).unwrap(),
        b"preserved"
    );
}
#[test]
fn known_cache_limit_is_not_close_uncertainty_and_existing_copies_remain_usable() {
    let fixture = Fixture::new();
    let mut cache = fixture.open();
    let now = Instant::now();
    let copies = (0..reverie_core::chat_images::MAX_CACHE_FILES)
        .map(|_| cache.install(PNG, now).unwrap())
        .collect::<Vec<_>>();
    let refused = cache.install(PNG, now).err().unwrap();
    assert_eq!(refused.code(), "cache_limit");
    assert!(!refused.is_uncertain());
    assert_eq!(
        cache.verify_copies(&copies, now).unwrap().len(),
        copies.len()
    );
    cache.begin(now).unwrap();
    cache
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
}
#[test]
fn actual_ledger_read_close_refusal_retains_original_constructor_uncertainty() {
    let fixture = Fixture::new();
    let mut cache = fixture.open();
    cache.install(PNG, Instant::now()).unwrap();
    cache.retire().unwrap();
    let ledger = fs::read(fixture.state.join(custody::NAME)).unwrap();
    crate::faults::STATE
        .with(|state| state.borrow_mut().close = Some(crate::private_fs::CloseRole::Data));
    let failure = ImageCache::open(&fixture.state, &fixture.cache)
        .err()
        .unwrap();
    crate::faults::reset();
    assert!(failure.error.is_uncertain());
    let mut retained = failure
        .retained
        .expect("actual constructor retained after read close");
    assert!(retained.retire().err().unwrap().is_uncertain());
    assert!(retained.retire().err().unwrap().is_uncertain());
    assert_eq!(fs::read(fixture.state.join(custody::NAME)).unwrap(), ledger);
    assert_eq!(fs::read_dir(&fixture.cache).unwrap().count(), 1);
}
#[test]
fn actual_checkpoint_close_refusal_is_typed_and_cannot_be_retried_to_success() {
    let fixture = Fixture::new();
    let mut cache = fixture.open();
    crate::faults::STATE
        .with(|state| state.borrow_mut().close = Some(crate::private_fs::CloseRole::Temporary));
    let error = cache.install(PNG, Instant::now()).err().unwrap();
    crate::faults::reset();
    assert!(error.is_uncertain());
    assert!(cache.retire().err().unwrap().is_uncertain());
    assert!(cache.close(Instant::now()).err().unwrap().is_uncertain());
}
#[test]
fn actual_verification_close_refusal_fences_forward_and_retains_retire_uncertainty() {
    let fixture = Fixture::new();
    let mut cache = fixture.open();
    let now = Instant::now();
    let copy = cache.install(PNG, now).unwrap();
    crate::faults::STATE
        .with(|state| state.borrow_mut().close = Some(crate::private_fs::CloseRole::Data));
    let error = cache.verify_copies(&[copy], now).err().unwrap();
    crate::faults::reset();
    assert!(error.is_uncertain());
    let forward = cache.begin(now);
    let retired = cache.retire();
    eprintln!(
        "after consumed Data close refusal: forward_ok={} retire_ok={}",
        forward.is_ok(),
        retired.is_ok()
    );
    assert!(
        forward.is_err(),
        "prior actual verification close must fence forward"
    );
    assert!(
        retired
            .expect_err("same cache must retain prior close")
            .is_uncertain()
    );
    assert!(cache.retire().err().unwrap().is_uncertain());
    assert_eq!(fs::read_dir(&fixture.cache).unwrap().count(), 1);
}
#[test]
fn internal_ancestor_close_refusal_survives_constructor_anchor_cleanup() {
    let fixture = Fixture::new();
    crate::faults::STATE
        .with(|state| state.borrow_mut().close = Some(crate::private_fs::CloseRole::Walk));
    let failure = ImageCache::open(&fixture.state, &fixture.cache)
        .err()
        .unwrap();
    crate::faults::reset();
    eprintln!(
        "internal Walk close refusal: uncertain={} retained={}",
        failure.error.is_uncertain(),
        failure.retained.is_some()
    );
    assert!(
        failure.error.is_uncertain(),
        "preserve actual consumed close cause"
    );
    let mut cache = failure.retained.expect("same failed constructor owner");
    assert!(cache.retire().err().unwrap().is_uncertain());
    assert!(cache.retire().err().unwrap().is_uncertain());
}
#[test]
fn shared_directory_stream_and_primary_failure_preserve_consumed_close_cause() {
    let fixture = Fixture::new();
    let file = fixture.base.join("not-a-directory");
    fs::write(&file, b"owned ordinary file").unwrap();
    for selected in [&fixture.cache, &file] {
        crate::faults::STATE
            .with(|state| state.borrow_mut().close = Some(crate::private_fs::CloseRole::Walk));
        let error = crate::private_fs::settlement_directory_names(selected).unwrap_err();
        crate::faults::reset();
        assert!(error.has_unconfirmed_close());
        assert!(
            !error.is_uncertain(),
            "generic publication predicate stays separate"
        );
        if selected == &file {
            assert!(matches!(error, crate::StoreError::Finalization { .. }));
        }
        assert!(ImageStoreError::from(error).is_uncertain());
    }
}
