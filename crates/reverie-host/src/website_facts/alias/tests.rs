//! Explicit immutable Nix fixtures observed through our actual /proc/self/root.
//! This proves file/link custody only, never a container, program or Q grant.
use super::*;
use sha2::{Digest, Sha256};
use std::{fs, io::Read, os::unix::fs::MetadataExt, path::PathBuf, time::Duration};
struct Fixture {
    invocation: PythonText,
    code: CodeFile,
    canonical: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let path = PathBuf::from(
            std::env::var_os("REVERIE_DEPLOYMENT_COPY")
                .expect("explicit immutable Nix coreutils invocation required"),
        );
        let invocation = PythonText::try_new(native::python_text(&path)).unwrap();
        nix_path(&invocation).unwrap();
        let canonical = fs::canonicalize(path).unwrap();
        let mut files = Descriptors::default();
        let body = (|| {
            let index = files.retain(code::read_open(&canonical)?);
            let info = files.get(index).metadata()?;
            need(
                info.is_file()
                    && info.uid() == 0
                    && info.mode() & 0o222 == 0
                    && info.len() <= code::MAX_CODE_FILE,
                "IMMUTABLE_TEST_FIXTURE_REQUIRED",
            )?;
            let mut bytes = Vec::new();
            files
                .get_mut(index)
                .take(code::MAX_CODE_FILE + 1)
                .read_to_end(&mut bytes)?;
            need(
                bytes.len() as u64 == info.len(),
                "IMMUTABLE_TEST_FIXTURE_CHANGED",
            )?;
            Ok(bytes)
        })();
        let bytes = files.finish(body, &mut false).unwrap();
        let code = CodeFile {
            path: PythonText::try_new(native::python_text(&canonical)).unwrap(),
            bytes: bytes.len() as u64,
            sha256: JournalDigest::parse(&format!("{:x}", Sha256::digest(&bytes))).unwrap(),
        };
        Self {
            invocation,
            code,
            canonical,
        }
    }
}
fn init() -> UnsignedInteger {
    UnsignedInteger::from_u64(u64::from(std::process::id()))
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(10)
}
#[test]
#[ignore = "requires explicit REVERIE_DEPLOYMENT_COPY and actual read-only UID0 Nix store"]
fn actual_immutable_host_and_guest_hashes_readonly_link_chain_and_final_inode_match() {
    let fixture = Fixture::new();
    assert!(
        fs::symlink_metadata(nix_path(&fixture.invocation).unwrap())
            .unwrap()
            .file_type()
            .is_symlink(),
        "positive must traverse an actual alias"
    );
    let mut alias = ImmutableAliasObserver::default();
    let selected = alias
        .observe_alias(
            &init(),
            &fixture.invocation,
            std::slice::from_ref(&fixture.code),
            end(),
        )
        .unwrap();
    assert_eq!(selected.canonical_path(), &fixture.code.path);
    let info = fs::metadata(&fixture.canonical).unwrap();
    assert_eq!(selected.identity(), [info.dev(), info.ino()]);
    let direct = ImmutableCodeObserver::default()
        .observe_file(&init(), &fixture.code, end())
        .unwrap();
    assert_eq!(direct.identity(), selected.identity());
}
#[test]
#[ignore = "requires explicit REVERIE_DEPLOYMENT_COPY and actual read-only UID0 Nix store"]
fn actual_alias_wrong_hash_duplicate_manifest_unmanifested_target_and_lexical_escape_refuse() {
    let fixture = Fixture::new();
    let mut alias = ImmutableAliasObserver::default();
    let mut wrong = fixture.code.clone();
    wrong.sha256 = JournalDigest::parse(&"0".repeat(64)).unwrap();
    assert_eq!(
        alias
            .observe_alias(&init(), &fixture.invocation, &[wrong], end())
            .err()
            .unwrap()
            .code(),
        "BACKEND_CODE_BYTES_CHANGED"
    );
    assert_eq!(
        alias
            .observe_alias(
                &init(),
                &fixture.invocation,
                &[fixture.code.clone(), fixture.code.clone()],
                end()
            )
            .err()
            .unwrap()
            .code(),
        "IMMUTABLE_CODE_BINDING"
    );
    let mut absent = fixture.code.clone();
    absent.path = PythonText::from_scalar_text("/nix/store/absent/code");
    assert_eq!(
        alias
            .observe_alias(&init(), &fixture.invocation, &[absent], end())
            .err()
            .unwrap()
            .code(),
        "UNMANIFESTED_BACKEND_CODE"
    );
    for bad in ["/etc/passwd", "/nix/store/../etc/passwd", "/nix/store/a\0b"] {
        assert!(
            alias
                .observe_alias(
                    &init(),
                    &PythonText::from_scalar_text(bad),
                    std::slice::from_ref(&fixture.code),
                    end()
                )
                .is_err()
        );
    }
    alias
        .observe_alias(
            &init(),
            &fixture.invocation,
            std::slice::from_ref(&fixture.code),
            end(),
        )
        .unwrap();
}
#[test]
#[ignore = "requires explicit REVERIE_DEPLOYMENT_COPY and actual read-only UID0 Nix store"]
fn actual_alias_consumed_close_failure_preserves_primary_and_never_reopens_after_uncertainty() {
    let fixture = Fixture::new();
    let mut alias = ImmutableAliasObserver::default();
    let mut wrong = fixture.code.clone();
    wrong.sha256 = JournalDigest::parse(&"0".repeat(64)).unwrap();
    native::test_faults::set(None, true);
    let first = alias.observe_alias(&init(), &fixture.invocation, &[wrong], end());
    native::test_faults::set(None, false);
    assert!(
        matches!(first.err().unwrap(),WebsiteFactsError::Finalization {ref primary,ref secondary}
        if primary.code()=="BACKEND_CODE_BYTES_CHANGED" && secondary.code()=="BACKEND_CODE_CLOSE_UNCONFIRMED")
    );
    assert_eq!(
        alias
            .observe_alias(
                &init(),
                &fixture.invocation,
                std::slice::from_ref(&fixture.code),
                end()
            )
            .err()
            .unwrap()
            .code(),
        "INVOCATION_ALIAS_CLOSE_UNCONFIRMED"
    );
    assert!(
        !fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| fs::read_link(entry.path()).ok())
            .any(|path| path == fixture.canonical
                || native::python_text(&path) == fixture.invocation.codepoints())
    );
}
#[test]
fn normalized_link_targets_match_posix_dotdot_floor_and_reject_nonstore_or_double_root() {
    let link = Path::new("/nix/store/fixed/bin/tool");
    for (target, expected) in [
        ("../lib/./tool", "/nix/store/fixed/lib/tool"),
        ("/tmp/../nix/store/a", "/nix/store/a"),
        ("///nix/store/a", "/nix/store/a"),
    ] {
        assert_eq!(
            walk::normalized_target(link, Path::new(target)).unwrap(),
            PathBuf::from(expected)
        );
    }
    for target in ["../../../../etc/passwd", "//nix/store/a", "/nix/other/code"] {
        assert!(walk::normalized_target(link, Path::new(target)).is_err());
    }
}
