use super::*;
#[test]
fn partial_and_interrupted_single_writes_are_uncertain_and_never_retried() {
    use super::super::target::faults::{self, WriteFault};
    for fault in [WriteFault::Short, WriteFault::Interrupted] {
        let fixture = KernelFixture::new();
        let target = fixture.target();
        faults::set(Some(fault));
        let mut attempted = false;
        let result = target.write_high("1073741824", end(), &mut attempted);
        assert_eq!(faults::calls(), 1);
        faults::set(None);
        assert!(attempted);
        assert!(matches!(
            classify(result, attempted),
            Err(LaptopError::MemoryEffectUnconfirmed(_))
        ));
        assert_eq!(
            fs::read_to_string(fixture.root.join("cgroup/laptop/memory.high")).unwrap(),
            match fault {
                WriteFault::Short => "1ax\n",
                WriteFault::Interrupted => "max\n",
            }
        );
        target.close().unwrap();
    }
}
#[test]
fn anchored_target_refuses_pid_membership_directory_and_symlink_replacement() {
    for mutation in ["pid", "membership", "directory", "symlink"] {
        let fixture = KernelFixture::new();
        let target = fixture.target();
        target.fences().unwrap();
        match mutation {
            "pid" => fixture.set(
                "proc/321/stat",
                &format!(
                    "321 (same) {}\n",
                    [vec!["S"; 19], vec!["124"]].concat().join(" ")
                ),
            ),
            "membership" => fixture.set("proc/321/cgroup", "0::/other\n"),
            "directory" => {
                fs::rename(
                    fixture.root.join("cgroup/laptop"),
                    fixture.root.join("cgroup/prior"),
                )
                .unwrap();
                fs::create_dir(fixture.root.join("cgroup/laptop")).unwrap();
            }
            "symlink" => {
                fs::rename(
                    fixture.root.join("cgroup/laptop"),
                    fixture.root.join("cgroup/prior"),
                )
                .unwrap();
                std::os::unix::fs::symlink("prior", fixture.root.join("cgroup/laptop")).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(target.fences().is_err(), "{mutation}");
        target.close().unwrap();
    }
}
#[test]
fn fixed_writer_deadline_and_readback_preserve_the_attempt_boundary() {
    let fixture = KernelFixture::new();
    let target = fixture.target();
    target.hard_is("2147483648").unwrap();
    assert!(target.hard_is("1073741824").is_err());
    let mut attempted = false;
    assert!(
        target
            .write_high("1073741824", Instant::now(), &mut attempted)
            .is_err()
    );
    assert!(!attempted);
    assert_eq!(
        fs::read_to_string(fixture.root.join("cgroup/laptop/memory.high")).unwrap(),
        "max\n"
    );
    target
        .write_high("1073741824", end(), &mut attempted)
        .unwrap();
    assert!(attempted);
    target.high_is("1073741824").unwrap();
    target.fences().unwrap();
    target.close().unwrap();
}
#[test]
fn checked_writer_and_leaf_close_failures_after_attempt_are_uncertain() {
    for writer_close in [false, true] {
        let fixture = KernelFixture::new();
        let target = fixture.target();
        let mut attempted = false;
        if writer_close {
            crate::native::test_faults::set(None, true);
        }
        let result = target.write_high("1073741824", end(), &mut attempted);
        if !writer_close {
            crate::native::test_faults::set(None, true);
        }
        let result = finalized(result, target.close());
        crate::native::test_faults::set(None, false);
        assert!(attempted);
        assert!(matches!(
            classify(result, attempted),
            Err(LaptopError::MemoryEffectUnconfirmed(_))
        ));
        assert_eq!(
            fs::read_to_string(fixture.root.join("cgroup/laptop/memory.high")).unwrap(),
            "1073741824\n"
        );
    }
}
#[test]
fn malformed_membership_and_intermediate_symlinks_never_reach_a_writer() {
    for groups in [
        "0::/\n",
        "0::/../laptop\n",
        "0::/laptop\n1:memory:/other\n",
        "0::/alias/laptop\n",
    ] {
        let fixture = KernelFixture::new();
        std::os::unix::fs::symlink(".", fixture.root.join("cgroup/alias")).unwrap();
        fixture.set("proc/321/cgroup", groups);
        assert!(
            super::super::target::Target::capture(
                321,
                &fixture.root.join("proc"),
                &fixture.root.join("cgroup")
            )
            .is_err()
        );
        assert_eq!(
            fs::read_to_string(fixture.root.join("cgroup/laptop/memory.high")).unwrap(),
            "max\n"
        );
    }
}
#[test]
fn writer_open_refusal_is_pre_effect_but_post_write_readback_failure_is_not() {
    let fixture = KernelFixture::new();
    let target = fixture.target();
    fs::remove_file(fixture.root.join("cgroup/laptop/memory.high")).unwrap();
    std::os::unix::fs::symlink("memory.max", fixture.root.join("cgroup/laptop/memory.high"))
        .unwrap();
    let mut attempted = false;
    let result = target.write_high("1073741824", end(), &mut attempted);
    assert!(!attempted);
    assert!(!matches!(
        classify(result, attempted),
        Err(LaptopError::MemoryEffectUnconfirmed(_))
    ));
    fs::remove_file(fixture.root.join("cgroup/laptop/memory.high")).unwrap();
    fixture.set("cgroup/laptop/memory.high", "max\n");
    target
        .write_high("1073741824", end(), &mut attempted)
        .unwrap();
    fixture.set("cgroup/laptop/memory.high", "0\n");
    assert!(matches!(
        classify(target.high_is("1073741824"), attempted),
        Err(LaptopError::MemoryEffectUnconfirmed(_))
    ));
    target.close().unwrap();
}

#[test]
fn real_permission_refusal_uses_the_existing_write_authority_code_without_an_attempt() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let fixture = KernelFixture::new();
    // Root can bypass mode bits. Refuse that test environment explicitly rather
    // than counting an unexecuted authority control as a passing test.
    assert_ne!(
        fs::metadata(&fixture.root).unwrap().uid(),
        0,
        "authority control requires the nonroot native test environment"
    );
    let target = fixture.target();
    let path = fixture.root.join("cgroup/laptop/memory.high");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    let mut attempted = false;
    let result = target.write_high("1073741824", end(), &mut attempted);
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(!attempted);
    assert!(matches!(
        result,
        Err(LaptopError::Refused("LAPTOP_SOFT_LIMIT_WRITE_AUTHORITY"))
    ));
    target.close().unwrap();
}
