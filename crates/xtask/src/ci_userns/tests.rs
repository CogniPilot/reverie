use super::*;

const EXECUTABLE: &str =
    "/nix/store/00000000000000000000000000000000-util-linux-2.42.2-bin/bin/unshare";
#[test]
fn only_declared_disposable_linux_ci_passes_accidental_use_guard() {
    assert!(
        declared_runner(
            Some("true"),
            Some("github-hosted"),
            Some("Linux"),
            Some("true")
        )
        .is_ok()
    );
    for values in [
        [None, Some("github-hosted"), Some("Linux"), Some("true")],
        [
            Some("false"),
            Some("github-hosted"),
            Some("Linux"),
            Some("true"),
        ],
        [Some("true"), None, Some("Linux"), Some("true")],
        [
            Some("true"),
            Some("self-hosted"),
            Some("Linux"),
            Some("true"),
        ],
        [
            Some("true"),
            Some("github-hosted"),
            Some("Windows"),
            Some("true"),
        ],
        [
            Some("true"),
            Some("github-hosted"),
            Some("Linux"),
            Some("false"),
        ],
    ] {
        assert!(declared_runner(values[0], values[1], values[2], values[3]).is_err());
    }
}
#[test]
fn distribution_requires_exact_unambiguous_supported_release() {
    assert!(ubuntu24("ID=ubuntu\nVERSION_ID=\"24.04\"\nOTHER=retained\n").is_ok());
    for source in [
        "ID=nixos\nVERSION_ID=\"24.04\"",
        "ID=ubuntu\nVERSION_ID=22.04",
        "ID=ubuntu\nID=ubuntu\nVERSION_ID=24.04",
        "ID=ubuntu\nVERSION_ID=24.04\nVERSION_ID=24.04",
        "",
    ] {
        assert!(ubuntu24(source).is_err());
    }
}
#[test]
fn exact_profile_has_one_attachment_and_only_named_user_namespace_permission() {
    let text = profile(Path::new(EXECUTABLE)).unwrap();
    assert_eq!(
        text,
        format!(
            "abi <abi/4.0>,\ninclude <tunables/global>\nprofile reverie-ci-owned-memory-userns \"{EXECUTABLE}\" flags=(unconfined) {{\n  userns,\n}}\n"
        )
    );
    for path in [
        "/usr/bin/unshare",
        "/nix/store/short-util-linux-2/bin/unshare",
        "/nix/store/00000000000000000000000000000000-caller/bin/unshare",
        "/nix/store/00000000000000000000000000000000-util-linux-2/bin/*",
        "/nix/store/00000000000000000000000000000000-util-linux-2/bin/unshare\ncapability,",
        "/nix/store/00000000000000000000000000000000-util-linux-\"2/bin/unshare",
        "/nix/store/00000000000000000000000000000000-util-linux-[2]/bin/unshare",
        "/nix/store/00000000000000000000000000000000-util-linux-2/../bin/unshare",
    ] {
        assert!(profile(Path::new(path)).is_err(), "{path}");
    }
}

#[cfg(target_os = "linux")]
mod transport {
    use super::*;
    use std::{
        fs,
        io::Read,
        process::{Command, Stdio},
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    #[test]
    #[ignore = "owned profile-stdin child; never runs sudo or AppArmor"]
    fn profile_stdin_child() {
        assert_eq!(
            std::env::var("XTASK_CI_PROFILE_CHILD").as_deref(),
            Ok("owned")
        );
        let mut bytes = Vec::new();
        std::io::stdin().read_to_end(&mut bytes).unwrap();
        fs::write(std::env::var_os("XTASK_CI_PROFILE_TRACE").unwrap(), bytes).unwrap();
        if std::env::var("XTASK_CI_PROFILE_REFUSE").as_deref() == Ok("yes") {
            std::process::exit(7);
        }
    }
    #[test]
    fn actual_bounded_stdin_reaches_owned_child_and_nonzero_never_reports_loaded() {
        for refused in [false, true] {
            let trace = std::env::temp_dir().join(format!(
                "ci-profile-input-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let rules = profile(Path::new(EXECUTABLE)).unwrap();
            let mut child = Command::new(std::env::current_exe().unwrap());
            // The exact trace below proves execution even on zero-case typos;
            // avoid counting nested libtest summaries as independent suites.
            child.stdout(Stdio::null());
            child
                .args([
                    "--exact",
                    "ci_userns::tests::transport::profile_stdin_child",
                    "--ignored",
                    "--test-threads=1",
                ])
                .env("XTASK_CI_PROFILE_CHILD", "owned")
                .env("XTASK_CI_PROFILE_TRACE", &trace)
                .env(
                    "XTASK_CI_PROFILE_REFUSE",
                    if refused { "yes" } else { "no" },
                );
            let result = super::super::linux::load(&mut child, rules.as_bytes());
            assert_eq!(
                fs::read(&trace).unwrap(),
                rules.as_bytes(),
                "actual helper required, not a zero-case exit"
            );
            assert_eq!(result.is_err(), refused);
            fs::remove_file(trace).unwrap();
        }
    }
}
