use reverie_contracts::prune::{
    AdmissionError as A, Config, ConfigError as C, ExitCode, Mode, MountObservation, Pass, Reason,
    RootObservation, ordered_reasons,
};

const BOUND: &str = r#"
[root_identities."/mnt/scratch"]
source = "/dev/fixture"
fstype = "ext4"
"#;
fn config(extra: &str) -> Config {
    Config::parse_toml(&format!("{extra}\n{BOUND}"), false).unwrap()
}
fn root() -> RootObservation {
    RootObservation {
        path: "/mnt/scratch".into(),
        canonical_path: Some("/mnt/scratch".into()),
        is_directory: true,
        is_symlink: false,
        device: Some((8, 1)),
        inode: Some(42),
    }
}
fn mount() -> MountObservation {
    MountObservation {
        point: "/mnt/scratch".into(),
        root: "/".into(),
        source: "/dev/fixture".into(),
        fstype: "ext4".into(),
        device: (8, 1),
    }
}
fn admit(c: &Config, r: RootObservation, m: Vec<MountObservation>) -> Result<(), A> {
    c.admit_roots(Pass::All, &[r], Some(&m), false).map(|_| ())
}
#[test]
fn r12_defaults_and_dry_only_boundary() {
    let c = Config::parse_toml("", false).unwrap();
    assert_eq!(c.b_mount(), "/mnt/scratch");
    assert_eq!(c.watermarks(), (50.0, 70.0));
    assert_eq!(c.max_delete_bytes(), 200 << 30);
    assert_eq!(
        c.paths(),
        (
            "/etc/reverie/prune-registry",
            "/var/log/reverie-prune",
            "/run/reverie-prune.lock",
            ""
        )
    );
    assert_eq!(c.mode(false, false), Ok(Mode::DryRun));
    assert_eq!(c.mode(true, true), Err(C::LiveDisabled));
    let c = config("live_enabled = true");
    assert_eq!(c.mode(true, false), Err(C::ProductionLiveUnavailable));
    assert_eq!(c.mode(true, true), Ok(Mode::TestRootLive));
}
#[test]
fn closed_config_types_and_numeric_bounds() {
    for text in [
        "unknown = true",
        "live_enabled = 1",
        "checkout_roots = 'x'",
        "max_delete_bytes = -1",
        "checkout_max_depth = -1",
        "lease_lib = 42",
        "root_identities = []",
        "test_trusted_uid = -1",
        "idle_days = true",
        "high_water_pct = 70\nhigh_water_pct = 80",
    ] {
        assert_eq!(Config::parse_toml(text, false), Err(C::Toml), "{text}");
    }
    for text in [
        "low_water_pct = -1",
        "low_water_pct = 80",
        "high_water_pct = 101",
        "low_water_pct = nan",
        "high_water_pct = inf",
    ] {
        assert_eq!(
            Config::parse_toml(text, false),
            Err(C::Watermarks),
            "{text}"
        );
    }
    for text in [
        "idle_days = nan",
        "idle_days = -1",
        "recent_write_hours = inf",
        "max_delete_seconds = -1",
        "lease_report_days = -inf",
    ] {
        assert_eq!(
            Config::parse_toml(text, false),
            Err(C::NonfiniteOrNegative),
            "{text}"
        );
    }
}
#[test]
fn fixture_switches_require_explicit_test_context() {
    for text in [
        "test_mode = true",
        "test_mountinfo = '/fixture/mountinfo'",
        "test_trusted_uid = 0",
        "test_unbound_ok = true",
    ] {
        assert_eq!(Config::parse_toml(text, false), Err(C::TestOnly));
        assert!(Config::parse_toml(text, true).is_ok());
    }
    let c = Config::parse_toml("test_unbound_ok = true", true).unwrap();
    assert_eq!(
        c.admit_roots(Pass::All, &[root()], None, false),
        Err(A::InvalidContext)
    );
    assert_eq!(c.mode(false, false), Err(C::TestOnly));
    assert!(c.admit_roots(Pass::All, &[root()], None, true).is_ok());
}
#[test]
fn legacy_lease_lib_is_only_inert_string_data() {
    for path in ["", "/does/not/exist", "../untrusted.py", "\u{0}"] {
        let text = format!("lease_lib = {}", serde_json::to_string(path).unwrap());
        assert!(Config::parse_toml(&text, false).is_ok(), "{path:?}");
    }
}
#[test]
fn manifest_is_a_plain_bounded_name_and_paths_reject_nul() {
    for name in [
        "",
        ".",
        "..",
        ".hidden",
        "../approvals",
        "/absolute",
        "a/b",
        "a b",
    ] {
        let text = format!("registry_manifest = {name:?}");
        assert_eq!(Config::parse_toml(&text, false), Err(C::Manifest));
    }
    assert_eq!(
        Config::parse_toml(&format!("registry_manifest = {:?}", "a".repeat(101)), false),
        Err(C::Manifest)
    );
    assert_eq!(
        Config::parse_toml("b_mount = \"/a\\u0000b\"", false),
        Err(C::Path)
    );
    assert_eq!(
        Config::parse_toml(&BOUND.replace("/dev/fixture", ""), false),
        Err(C::Identity)
    );
}
#[test]
fn admission_keeps_exact_anchor_and_refuses_drift() {
    let c = config("");
    let anchors = c
        .admit_roots(Pass::All, &[root()], Some(&[mount()]), false)
        .unwrap();
    let anchor = &anchors[0];
    assert_eq!(anchor.path(), "/mnt/scratch");
    assert_eq!(anchor.device(), (8, 1));
    assert_eq!(anchor.inode(), 42);
    assert!(anchor.matches(&root()));
    let mut r = root();
    r.inode = Some(43);
    assert!(!anchor.matches(&r));
    let mut r = root();
    r.is_symlink = true;
    assert!(!anchor.matches(&r));
    let mut r = root();
    r.canonical_path = None;
    assert!(!anchor.matches(&r));
    let mut r = root();
    r.device = Some((8, 2));
    assert!(!anchor.matches(&r));
}
#[test]
fn missing_or_ambiguous_facts_never_give_partial_admission() {
    let c = config("");
    assert_eq!(
        c.admit_roots(Pass::All, &[], Some(&[mount()]), false),
        Err(A::MissingObservation)
    );
    assert_eq!(
        c.admit_roots(Pass::All, &[root(), root()], Some(&[mount()]), false),
        Err(A::MissingObservation)
    );
    assert_eq!(
        c.admit_roots(Pass::All, &[root()], None, false),
        Err(A::MissingMount)
    );
    assert_eq!(admit(&c, root(), vec![]), Err(A::MissingMount));
    assert_eq!(
        admit(
            &Config::parse_toml("", false).unwrap(),
            root(),
            vec![mount()]
        ),
        Err(A::UnknownIdentity)
    );
    let mut r = root();
    r.device = None;
    assert_eq!(admit(&c, r, vec![mount()]), Err(A::MissingObservation));
    let mut r = root();
    r.inode = None;
    assert_eq!(admit(&c, r, vec![mount()]), Err(A::MissingObservation));
}
#[test]
fn symlink_noncanonical_directory_device_and_mount_refusals() {
    let c = config("");
    let mut r = root();
    r.is_symlink = true;
    assert_eq!(admit(&c, r, vec![mount()]), Err(A::NotCanonicalDirectory));
    let mut r = root();
    r.is_directory = false;
    assert_eq!(admit(&c, r, vec![mount()]), Err(A::NotCanonicalDirectory));
    let mut r = root();
    r.canonical_path = Some("/other".into());
    assert_eq!(admit(&c, r, vec![mount()]), Err(A::NotCanonicalDirectory));
    let mut r = root();
    r.canonical_path = None;
    assert_eq!(admit(&c, r, vec![mount()]), Err(A::NotCanonicalDirectory));
    let mut r = root();
    r.device = Some((8, 2));
    assert_eq!(admit(&c, r, vec![mount()]), Err(A::DeviceMismatch));
    let mut m = mount();
    m.point = "/mnt".into();
    assert_eq!(admit(&c, root(), vec![m]), Err(A::NotMountPoint));
    let mut m = mount();
    m.point = "/mnt/scratch2".into();
    assert_eq!(admit(&c, root(), vec![m]), Err(A::MissingMount));
    for field in ["source", "fstype", "root"] {
        let mut m = mount();
        match field {
            "source" => m.source = "wrong".into(),
            "fstype" => m.fstype = "wrong".into(),
            _ => m.root = "/sub".into(),
        }
        assert!(admit(&c, root(), vec![m]).is_err(), "{field}");
    }
}
#[test]
fn full_root_invariant_is_unconditional_and_last_mount_wins() {
    let c = config("");
    let subtree = Config::parse_toml(&format!("{BOUND}mount_root = '/sub'"), false).unwrap();
    let mut m = mount();
    m.root = "/sub".into();
    assert_eq!(admit(&subtree, root(), vec![m]), Err(A::NotFullFilesystem));
    let mut wrong = mount();
    wrong.source = "wrong".into();
    assert_eq!(
        admit(&c, root(), vec![mount(), wrong.clone()]),
        Err(A::IdentityMismatch)
    );
    assert_eq!(admit(&c, root(), vec![wrong, mount()]), Ok(()));
    let mut outer = mount();
    outer.point = "/".into();
    outer.source = "wrong".into();
    assert_eq!(admit(&c, root(), vec![mount(), outer]), Ok(()));
}
#[test]
fn checkout_admission_is_selected_by_pass() {
    let c = config("checkout_roots = ['/work']");
    assert!(
        c.admit_roots(Pass::HighWater, &[root()], Some(&[mount()]), false)
            .is_ok()
    );
    assert!(
        c.admit_roots(Pass::Retired, &[root()], Some(&[mount()]), false)
            .is_ok()
    );
    for pass in [Pass::All, Pass::Checkouts] {
        assert_eq!(
            c.admit_roots(pass, &[root()], Some(&[mount()]), false),
            Err(A::MissingObservation)
        );
    }
    let c = Config::parse_toml(&format!("checkout_roots = ['/work/repo']\n{BOUND}\n[root_identities.'/work/repo']\nsource='/dev/other'\nfstype='xfs'\nmount_root='/sub'"), false).unwrap();
    let mut checkout = root();
    checkout.path = "/work/repo".into();
    checkout.canonical_path = Some(checkout.path.clone());
    checkout.device = Some((8, 2));
    let m = MountObservation {
        point: "/work".into(),
        root: "/sub".into(),
        source: "/dev/other".into(),
        fstype: "xfs".into(),
        device: (8, 2),
    };
    assert_eq!(
        c.admit_roots(Pass::All, &[root(), checkout], Some(&[mount(), m]), false)
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn reasons_are_r12_ordered_deduplicated_and_exit_codes_stable() {
    let expected = [
        "anchor_changed",
        "repo_unbound",
        "registry_changed",
        "registry_untrusted",
        "proc_unreadable",
        "lease_unknown",
        "lease_held",
        "reserved",
        "barrier_busy",
        "open_file",
        "cwd",
        "recent_write",
        "tool_lock",
        "keep",
        "mount",
        "symlink_path",
        "walk_error",
        "git_unsafe",
        "registry_invalid",
        "not_idle",
    ];
    let reasons = [
        Reason::AnchorChanged,
        Reason::RepoUnbound,
        Reason::RegistryChanged,
        Reason::RegistryUntrusted,
        Reason::ProcUnreadable,
        Reason::LeaseUnknown,
        Reason::LeaseHeld,
        Reason::Reserved,
        Reason::BarrierBusy,
        Reason::OpenFile,
        Reason::Cwd,
        Reason::RecentWrite,
        Reason::ToolLock,
        Reason::Keep,
        Reason::Mount,
        Reason::SymlinkPath,
        Reason::WalkError,
        Reason::GitUnsafe,
        Reason::RegistryInvalid,
        Reason::NotIdle,
    ];
    let mut reversed = reasons.to_vec();
    reversed.reverse();
    reversed.extend(reasons);
    let got = ordered_reasons(reversed);
    assert_eq!(
        serde_json::to_value(got).unwrap(),
        serde_json::json!(expected)
    );
    assert_eq!(
        [
            ExitCode::Ok as i32,
            ExitCode::Config as i32,
            ExitCode::LiveRefused as i32,
            ExitCode::Partial as i32,
            ExitCode::Busy as i32
        ],
        [0, 2, 3, 4, 5]
    );
}

#[test]
fn actual_python_r12_defaults_and_admission_oracle() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/prune-r12.json")).unwrap();
    let mut defaults = serde_json::to_value(Config::parse_toml("", false).unwrap()).unwrap();
    defaults.as_object_mut().unwrap().remove("test_mode");
    let mut reference = fixture["defaults"].clone();
    for field in [
        "high_water_pct",
        "low_water_pct",
        "idle_days",
        "recent_write_hours",
        "max_delete_seconds",
        "lease_report_days",
    ] {
        reference[field] = serde_json::json!(reference[field].as_f64().unwrap());
    }
    assert_eq!(defaults, reference);
    for case in fixture["admission"].as_array().unwrap() {
        let raw = serde_json::json!({"b_mount":case["b_mount"],"checkout_roots":case["checkouts"],"root_identities":case["identities"],"test_unbound_ok":case["test_unbound"]});
        // TOML serialization retains the actual decoded config structure.
        let c = Config::parse_toml(
            &toml::to_string(&raw).unwrap(),
            case["test_unbound"] == true,
        )
        .unwrap();
        let roots: Vec<RootObservation> = serde_json::from_value(case["roots"].clone()).unwrap();
        let mounts: Vec<MountObservation> = serde_json::from_value(case["mounts"].clone()).unwrap();
        let pass = if case["check"] == true {
            Pass::All
        } else {
            Pass::HighWater
        };
        assert_eq!(
            c.admit_roots(pass, &roots, Some(&mounts), case["test_unbound"] == true)
                .is_ok(),
            case["accepted"] == true,
            "{}",
            case["name"]
        );
    }
}

#[test]
fn config_errors_have_a_stable_human_diagnostic() {
    let err = Config::parse_toml("unknown = true", false).unwrap_err();
    assert_eq!(err.to_string(), "prune config: Toml");
}
