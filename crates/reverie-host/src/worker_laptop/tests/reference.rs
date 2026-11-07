//! Actual unmodified Python handle prefix, with explicitly synthetic engine,
//! budget/allowed/Office facts. Rust counterpart uses the real captured client.
use super::*;
use crate::command_telemetry::CommandTelemetry;
#[test]
fn original_full_handle_create_record_start_bytes_and_explicit_alias_delta_match() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::reference::original_full_handle_create_record_start_bytes_and_explicit_alias_delta_match",
    ) {
        return;
    }
    // This is the one isolated owning process, not a concurrent harness change.
    let _previous = nix::sys::stat::umask(nix::sys::stat::Mode::from_bits_truncate(0o022));
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../legacy-create-start.json")).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 6);
    for case in cases {
        run(case);
    }
}
fn run(case: &serde_json::Value) {
    use std::os::unix::fs::symlink;
    let style = case["style"].as_str().unwrap();
    let mode = if case["name"] == "noncanonical" {
        "created-noncanonical"
    } else {
        "created-normal"
    };
    let fixture = Fixture::new(mode);
    let (nix, plan, _request, phone) = fixture.resources();
    // Preserve the exact original request bytes/order, rather than serde's
    // sorted-map fixture encoding (which describes a different valid request).
    let request = WorkerRequest::decode(
        case["request"].as_str().unwrap().as_bytes(),
        &fixture.source,
    )
    .unwrap();
    let workflow = fixture
        .runtime()
        .retain_laptop_network(&nix, plan, request, phone)
        .unwrap_or_else(|_| panic!("actual resource transfer"));
    fixture
        .runtime()
        .run_laptop_network(&workflow, end())
        .unwrap();
    let telemetry = CommandTelemetry::capture(fixture.runtime(), &fixture.source).unwrap();
    let LaptopCreation::Created(created) = fixture
        .runtime()
        .create_laptop(&workflow, &telemetry, end())
        .unwrap()
    else {
        panic!("actual create");
    };
    let home = fixture.root.join("state").join(SID).join("home");
    let launch = home.join(".reverie-launch");
    let metadata = fixture.root.join("state").join(SID).join("runtime.json");
    if style == "0755" || style == "0777" {
        fs::create_dir(&launch).unwrap();
        fs::set_permissions(
            &launch,
            fs::Permissions::from_mode(if style == "0755" { 0o755 } else { 0o777 }),
        )
        .unwrap();
    }
    let victim = fixture.root.join("victim");
    if style == "symlink" || style == "hardlink" {
        fs::write(&victim, b"prior owned metadata").unwrap();
        if style == "symlink" {
            symlink(&victim, &metadata).unwrap();
        } else {
            fs::hard_link(&victim, &metadata).unwrap();
        }
    }
    let result = fixture.runtime().publish_laptop_launch(&created);
    if case["rustExpectedRefusal"].as_bool().unwrap() {
        assert!(result.is_err(), "{}", case["name"]);
        if victim.exists() {
            assert_eq!(fs::read(&victim).unwrap(), b"prior owned metadata");
        }
        assert!(
            fixture
                .runtime()
                .start_laptop_container(&created, end())
                .is_err()
        );
        assert!(!fixture.root.join("started-laptop").exists());
    } else {
        result.unwrap();
        assert_positive(&fixture, &created, &launch, &metadata, &case["snapshot"]);
    }
    assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
}
fn assert_positive(
    fixture: &Fixture,
    created: &CreatedLaptop,
    launch: &Path,
    metadata: &Path,
    snapshot: &serde_json::Value,
) {
    let raw = fs::read_to_string(metadata).unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let nonce = value["exit"]
        .as_str()
        .unwrap()
        .strip_suffix(".exit")
        .unwrap();
    assert_eq!(nonce.as_bytes()[14], b'4');
    assert!(matches!(nonce.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    let record = launch.join(format!("{nonce}.json"));
    assert_eq!(
        fs::read_to_string(&record).unwrap(),
        snapshot["record"].as_str().unwrap()
    );
    assert_eq!(
        raw.replace(nonce, "$NONCE"),
        snapshot["metadata"].as_str().unwrap()
    );
    for (path, key) in [
        (record.as_path(), "recordMode"),
        (launch, "parentMode"),
        (metadata, "metadataMode"),
    ] {
        assert_eq!(
            u64::from(fs::metadata(path).unwrap().mode() & 0o777),
            snapshot[key].as_u64().unwrap()
        );
    }
    assert!(matches!(
        fixture
            .runtime()
            .start_laptop_container(created, end())
            .unwrap(),
        ContainerStart::Started(_)
    ));
    let root = fixture.root.to_str().unwrap();
    let uidgid = format!(
        "{}:{}",
        fs::metadata(&fixture.root).unwrap().uid(),
        fs::metadata(&fixture.root).unwrap().gid()
    );
    let actual = fs::read_to_string(fixture.root.join("trace"))
        .unwrap()
        .lines()
        .map(|line| {
            line.split('\0')
                .map(|arg| {
                    if arg.starts_with("reverie.worker-config=") {
                        "reverie.worker-config=$CONFIG_DIGEST".to_owned()
                    } else if arg.starts_with("reverie.worker-policy=") {
                        "reverie.worker-policy=$POLICY_DIGEST".to_owned()
                    } else {
                        arg.replace(root, "$ROOT").replace(&uidgid, "$UID:$GID")
                    }
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let expected = snapshot["trace"]
        .as_array()
        .unwrap()
        .iter()
        .skip(1)
        .map(|row| {
            row.as_array()
                .unwrap()
                .iter()
                .map(|arg| arg.as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    // Original first existing-container inspect belongs to the App's earlier
    // reuse/replacement phase. This Host record begins at the real Nix result.
    assert_eq!(actual, expected);
}
