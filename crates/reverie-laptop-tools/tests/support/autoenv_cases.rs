use crate::autoenv_fixture::Fixture;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};

fn json(fixture: &Fixture) -> Vec<u8> {
    format!(r#"{{"variables":{{"PATH":{{"type":"exported","value":"{}"}},"AUTOENV_PROBE":{{"type":"exported","value":"active"}},"HOME":{{"type":"exported","value":"/forbidden"}},"OTHER":{{"type":"local","value":"ignored"}}}}}}"#, fixture.cached.display()).into_bytes()
}
#[test]
fn actual_builder_and_exec_consumer_share_key_approval_and_preserve_caller_home() {
    let fixture = Fixture::new();
    let built = fixture.build(&json(&fixture));
    assert!(
        built.status.success(),
        "{}",
        String::from_utf8_lossy(&built.stderr)
    );
    let key = fixture.key();
    let child = fixture
        .command(fixture.shim.join("cargo"))
        .args(["build", "argument with spaces", "$not-expanded"])
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let pid = child.id();
    let output = child.wait_with_output().unwrap();
    let values = Fixture::values(&output);
    assert_eq!(values["AUTOENV_PROBE"], "active");
    assert_eq!(values["OTHER"], "<unset>");
    assert_eq!(values["HOME"], fixture.root.to_str().unwrap());
    assert_eq!(values["REVERIE_AUTOENV_ACTIVE"], key);
    assert_eq!(
        values["PID"],
        pid.to_string(),
        "launcher actually execs the selected tool"
    );
    assert_eq!(values["ARG"], "$not-expanded");
    assert!(values["PATH"].starts_with(fixture.cached.to_str().unwrap()));
    assert!(!values["PATH"].contains(fixture.shim.to_str().unwrap()));
    assert!(fixture.root.join("helper-called").exists());
    let manifest = fs::read_to_string(fixture.cache.join(format!("{key}.json"))).unwrap();
    assert!(manifest.contains("AUTOENV_PROBE"));
}
#[test]
fn actual_nix_subprocess_receives_only_fixed_argv_and_selected_repository_attribute() {
    let fixture = Fixture::new();
    let source = fixture.root.join("source.json");
    let argv = fixture.root.join("nix-argv");
    fs::write(&source, json(&fixture)).unwrap();
    let output = fixture
        .builder()
        .arg("build")
        .arg(&fixture.repo)
        .env("AUTOENV_TEST_NIX_JSON", source)
        .env("AUTOENV_TEST_NIX_ARGV", &argv)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(argv).unwrap(),
        format!(
            "print-dev-env\0--json\0--offline\0{}#devShells.default",
            fixture.repo.display()
        )
    );
}
#[test]
fn builder_and_consumer_agree_on_python_classes_and_first_matching_rule() {
    let mut fixture = Fixture::new();
    let repository = fixture.root.join("a]");
    fs::rename(&fixture.repo, &repository).unwrap();
    fixture.repo = repository;
    fixture.approve(&format!("{}/[[:alpha:]]", fixture.root.display()));
    assert!(fixture.build(&json(&fixture)).status.success());
    let output = fixture
        .command(fixture.shim.join("cargo"))
        .output()
        .unwrap();
    assert_eq!(Fixture::values(&output)["AUTOENV_PROBE"], "active");
    fs::write(
        &fixture.config,
        "* devShells.default rustc\r\n* other cargo\r\n",
    )
    .unwrap();
    let output = fixture
        .command(fixture.shim.join("cargo"))
        .output()
        .unwrap();
    assert_eq!(Fixture::values(&output)["AUTOENV_PROBE"], "<unset>");
    fs::write(&fixture.config, "unmatched-malformed\n*\n* later cargo\n").unwrap();
    assert!(!fixture.build(&json(&fixture)).status.success());
}
#[test]
fn changed_flake_and_bad_helper_output_cannot_reuse_old_environment_or_override_jobs() {
    let fixture = Fixture::new();
    assert!(fixture.build(&json(&fixture)).status.success());
    let before = fixture.key();
    fs::write(fixture.repo.join("flake.lock"), b"updated lock\n").unwrap();
    assert_ne!(before, fixture.key());
    for value in ["", "0", " 3", "3 ", "3\n4", "-1", "3x"] {
        let output = fixture
            .command(fixture.shim.join("cargo"))
            .env("AUTOENV_TEST_HELPER_OUTPUT", value)
            .output()
            .unwrap();
        let values = Fixture::values(&output);
        assert_eq!(values["AUTOENV_PROBE"], "<unset>");
        assert_eq!(values["CARGO_BUILD_JOBS"], "<unset>");
    }
    let output = fixture
        .command(fixture.shim.join("cargo"))
        .env("AUTOENV_TEST_HELPER_OUTPUT", "3\n\n")
        .output()
        .unwrap();
    assert_eq!(Fixture::values(&output)["CARGO_BUILD_JOBS"], "3");
    let output = fixture
        .command(fixture.shim.join("cargo"))
        .env("AUTOENV_TEST_HELPER_OUTPUT", "3")
        .env("AUTOENV_TEST_HELPER_EXIT", "1")
        .output()
        .unwrap();
    assert_eq!(Fixture::values(&output)["CARGO_BUILD_JOBS"], "<unset>");
}
#[test]
fn empty_path_component_does_not_restart_a_skipped_shim_alias_or_repeat_jobs_policy() {
    let fixture = Fixture::new();
    let aliases = fixture.root.join("aliases");
    fs::create_dir(&aliases).unwrap();
    symlink(
        env!("CARGO_BIN_EXE_reverie-autoenv-shim"),
        aliases.join("cargo"),
    )
    .unwrap();
    let mut path = aliases.into_os_string();
    path.push("::");
    path.push(&fixture.plain);
    let output = fixture
        .command(fixture.shim.join("cargo"))
        .env("PATH", path)
        .env("IN_NIX_SHELL", "1")
        .env("AUTOENV_TEST_HELPER_OUTPUT", "invalid")
        .env("AUTOENV_TEST_HELPER_EXIT", "1")
        .output()
        .unwrap();
    assert_eq!(Fixture::values(&output)["CARGO_BUILD_JOBS"], "<unset>");
    assert_eq!(
        fs::read(fixture.root.join("helper-called")).unwrap(),
        b"called\n"
    );
}
#[test]
fn malformed_old_cache_is_rejected_before_any_environment_variable_is_applied() {
    let fixture = Fixture::new();
    assert!(fixture.build(&json(&fixture)).status.success());
    let path = fixture.cache.join(format!("{}.env", fixture.key()));
    for raw in [
        b"AUTOENV_PROBE=partial\0prefix\0HOME=/owned/redirected-home\0".as_slice(),
        b"AUTOENV_PROBE=partial\0HOME=/forbidden\0",
        b"AUTOENV_PROBE=partial\0OTHER=unterminated",
    ] {
        fs::write(&path, raw).unwrap();
        let output = fixture
            .command(fixture.shim.join("cargo"))
            .output()
            .unwrap();
        let values = Fixture::values(&output);
        assert_eq!(values["HOME"], fixture.root.to_str().unwrap());
        assert_eq!(values["AUTOENV_PROBE"], "<unset>");
        assert_eq!(values["REVERIE_AUTOENV_ACTIVE"], "<unset>");
        assert!(!output.stderr.is_empty());
    }
}
#[test]
fn invalid_export_names_and_unsafe_cache_leaves_never_replace_existing_cache() {
    let fixture = Fixture::new();
    assert!(fixture.build(&json(&fixture)).status.success());
    let path = fixture.cache.join(format!("{}.env", fixture.key()));
    let before = fs::read(&path).unwrap();
    assert!(
        !fixture
            .build(
                br#"{"variables":{"prefix\u0000HOME":{"type":"exported","value":"/forbidden"}}}"#
            )
            .status
            .success()
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    let sentinel = fixture.root.join("sentinel");
    fs::write(&sentinel, b"unchanged").unwrap();
    fs::remove_file(&path).unwrap();
    symlink(&sentinel, &path).unwrap();
    assert!(!fixture.build(&json(&fixture)).status.success());
    assert_eq!(fs::read(sentinel).unwrap(), b"unchanged");
    assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());
    assert_eq!(
        fs::read_dir(&fixture.cache).unwrap().count(),
        2,
        "private temporary files cleaned on refusal"
    );
}
#[test]
fn opt_out_explicit_jobs_guards_and_missing_cache_preserve_passthrough() {
    for args in [
        vec!["build", "-j", "3"],
        vec!["build", "-j8"],
        vec!["build", "--jobs", "4"],
        vec!["build", "--jobs=5"],
    ] {
        let fixture = Fixture::new();
        let output = fixture
            .command(fixture.shim.join("cargo"))
            .args(args)
            .env("IN_NIX_SHELL", "1")
            .output()
            .unwrap();
        assert_eq!(Fixture::values(&output)["CARGO_BUILD_JOBS"], "<unset>");
        assert!(!fixture.root.join("helper-called").exists());
    }
    let fixture = Fixture::new();
    assert!(fixture.build(&json(&fixture)).status.success());
    for (name, value, expected) in [
        ("REVERIE_NO_AUTOENV", "1", "<unset>"),
        ("CARGO_BUILD_JOBS", "7", "7"),
    ] {
        let output = fixture
            .command(fixture.shim.join("cargo"))
            .env(name, value)
            .output()
            .unwrap();
        assert_eq!(Fixture::values(&output)["CARGO_BUILD_JOBS"], expected);
        assert!(!fixture.root.join("helper-called").exists());
    }
    for name in ["IN_NIX_SHELL", "REVERIE_AUTOENV_ACTIVE"] {
        let output = fixture
            .command(fixture.shim.join("cargo"))
            .env(name, "existing")
            .output()
            .unwrap();
        assert_eq!(Fixture::values(&output)["AUTOENV_PROBE"], "<unset>");
    }
    fs::remove_file(fixture.cache.join(format!("{}.env", fixture.key()))).unwrap();
    let output = fixture
        .command(fixture.shim.join("cargo"))
        .output()
        .unwrap();
    assert_eq!(Fixture::values(&output)["AUTOENV_PROBE"], "<unset>");
    assert!(String::from_utf8_lossy(&output.stderr).contains("reverie-autoenv build"));
    fs::set_permissions(&fixture.cache, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(!fixture.build(&json(&fixture)).status.success());
}
