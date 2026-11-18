mod fixture;

use super::*;
use fixture::{DIRS, Fixture, Member, deadline, layer, program, sha};
use reverie_contracts::resource_actor::HUMAN_TERMINAL_FILES;
use serde_json::{Value, json};
use std::io::Cursor;
use tar::EntryType;

#[test]
fn worker_provenance_emits_native_inventory_and_binds_real_archive_and_toolkit() {
    for arm in [false, true] {
        let fixture = Fixture::new(arm);
        let file = fixture.archive(&[fixture.entries()], false, false);
        let build = fixture.qualify(&file, deadline()).unwrap();
        let raw = fs::read(&file).unwrap();
        let pins = fixture_pins();
        let encoded = document(&build, &raw, &pins).unwrap();
        assert_eq!(encoded["version"], 2);
        assert_eq!(encoded["purpose"], "worker-image-provenance-v2");
        assert_eq!(encoded["factory"], fixture.profile);
        assert_eq!(encoded["archive"]["sha256"], sha(&raw));
        assert_eq!(encoded["archive"]["bytes"], raw.len());
        assert_eq!(
            encoded["imageSpec"]["Architecture"],
            fixture.image["architecture"]
        );
        assert_eq!(encoded["imageSpec"]["Config"], fixture.image["config"]);
        assert_eq!(encoded["toolkit"]["files"], fixture.manifest["files"]);
        let files = encoded["source"]["factoryFiles"].as_object().unwrap();
        assert_eq!(files.len(), worker_factory_files().len());
        assert!(
            files
                .keys()
                .all(|name| !name.ends_with(".py") && !name.starts_with("python/"))
        );
        assert_eq!(
            files[WORKER_FACTORY_INVENTORY_PATH]["sha256"],
            sha(WORKER_FACTORY_INVENTORY.as_bytes())
        );
        assert!(document(&build, &raw, &pins[1..]).is_err());
        let mut wrong = pins;
        wrong.swap(0, 1);
        assert!(document(&build, &raw, &wrong).is_err());
        if !arm && let Some(output) = std::env::var_os("REVERIE_WORKER_PROVENANCE_FIXTURE_OUT") {
            export_fixture(&PathBuf::from(output), &fixture, &raw);
        }
    }
}

fn fixture_pins() -> Vec<CodeFile> {
    worker_factory_files()
        .iter()
        .map(|name| {
            let path = Path::new("/nix/store/fixture-source").join(name);
            let raw = if *name == WORKER_FACTORY_INVENTORY_PATH {
                WORKER_FACTORY_INVENTORY.as_bytes()
            } else {
                name.as_bytes()
            };
            pin(&path, raw).unwrap()
        })
        .collect()
}

fn document(build: &WorkerImageProvenanceBuild, raw: &[u8], pins: &[CodeFile]) -> Result<Value> {
    let archive = pin(Path::new("/nix/store/fixture-image.tar.gz"), raw)?;
    let source = input::text(Path::new("/nix/store/fixture-source"))?;
    Ok(serde_json::from_slice(
        &build.encode(&archive, &source, pins)?,
    )?)
}

fn export_fixture(root: &Path, fixture: &Fixture, archive: &[u8]) {
    fs::create_dir(root).unwrap();
    fs::write(root.join("worker.tar.gz"), archive).unwrap();
    fs::write(root.join("profile.json"), fixture.profile.to_string()).unwrap();
    let toolkit = root.join("toolkit");
    let manifest = toolkit.join("share/reverie-human-terminal/manifest.json");
    fs::create_dir_all(manifest.parent().unwrap()).unwrap();
    fs::write(manifest, fixture.manifest.to_string()).unwrap();
    for target in HUMAN_TERMINAL_FILES {
        let path = toolkit.join(target.trim_start_matches('/'));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, &fixture.program).unwrap();
    }
}

#[test]
fn worker_provenance_refuses_invalid_factory_and_image_identity() {
    let mut fixture = Fixture::new(false);
    let profile = fixture.profile.clone();
    let file = fixture.archive(&[fixture.entries()], false, false);
    for (key, value) in [
        ("uid", json!(true)),
        ("gid", json!(1.0)),
        ("browser", json!(1)),
        ("uid", json!(0)),
        ("subidCount", json!(65535)),
        ("subuidStart", json!(1000)),
        ("subgidStart", json!(4294967290_u64)),
        ("unknown", json!("extra")),
    ] {
        fixture.profile = profile.clone();
        fixture.profile[key] = value;
        assert!(fixture.qualify(&file, deadline()).is_err(), "{key}");
    }
    fixture.profile = profile;
    let config = fixture.image.clone();
    for (key, value) in [("User", json!("2000:2000")), ("Cmd", json!(["arbitrary"]))] {
        fixture.image = config.clone();
        fixture.image["config"][key] = value;
        assert_unqualified(&fixture, &[fixture.entries()]);
    }
    fixture.image = config.clone();
    fixture.image["architecture"] = json!("arm64");
    assert_unqualified(&fixture, &[fixture.entries()]);
    for (label, value) in [
        ("org.reverie.worker.rootless-docker", json!("0")),
        ("org.reverie.worker.subid-count", json!("131072")),
        ("org.reverie.worker.browser", json!("1")),
        ("org.reverie.worker.browser", Value::Null),
    ] {
        fixture.image = config.clone();
        fixture.image["config"]["Labels"][label] = value;
        assert_unqualified(&fixture, &[fixture.entries()]);
    }
}

fn assert_unqualified(fixture: &Fixture, layers: &[Vec<Member<'_>>]) {
    let path = fixture.archive(layers, false, false);
    assert!(fixture.qualify(&path, deadline()).is_err());
}

#[test]
fn worker_provenance_static_toolkit_and_manifest_refuse_mismatches() {
    let mut fixture = Fixture::new(false);
    let manifest = fixture.manifest.clone();
    let file = fixture.archive(&[fixture.entries()], false, false);
    fixture.manifest["files"]
        .as_object_mut()
        .unwrap()
        .remove(HUMAN_TERMINAL_FILES[0]);
    assert!(fixture.qualify(&file, deadline()).is_err());
    for wrong in [json!(true), json!((16 << 20) + 1)] {
        fixture.manifest = manifest.clone();
        fixture.manifest["files"][HUMAN_TERMINAL_FILES[0]]["bytes"] = wrong;
        assert!(fixture.qualify(&file, deadline()).is_err());
    }
    fixture.manifest = manifest.clone();
    fixture.manifest["static"] = json!(false);
    assert!(fixture.qualify(&file, deadline()).is_err());
    fixture.manifest = manifest;
    fixture.program[0] = 0;
    assert!(fixture.qualify(&file, deadline()).is_err());
    for (kind, diagnostic) in [(3, "interpreter"), (2, "dependency")] {
        let raw = program(62, kind);
        let target = pin(Path::new(HUMAN_TERMINAL_FILES[0]), &raw).unwrap();
        let error = qualify_toolkit_binary(&raw, &target, 62).unwrap_err();
        assert!(error.to_string().contains(diagnostic), "{error}");
    }
}

#[test]
fn worker_provenance_does_not_adopt_unknown_layer_or_wrong_uncompressed_digest() {
    let fixture = Fixture::new(false);
    for (wrong_digest, extra) in [(true, false), (false, true)] {
        let path = fixture.archive(&[fixture.entries()], wrong_digest, extra);
        assert!(fixture.qualify(&path, deadline()).is_err());
    }
}

#[test]
fn worker_provenance_checks_direct_bytes_modes_ownership_and_ancestor_types() {
    let fixture = Fixture::new(false);
    for bad in [
        Member {
            kind: EntryType::Symlink,
            bytes: b"",
            ..fixture.entries().pop().unwrap()
        },
        Member {
            kind: EntryType::Link,
            bytes: b"",
            ..fixture.entries().pop().unwrap()
        },
        Member {
            mode: 0o755,
            ..fixture.entries().pop().unwrap()
        },
        Member {
            uid: 1200,
            ..fixture.entries().pop().unwrap()
        },
        Member {
            bytes: &vec![b'x'; fixture.program.len()],
            ..fixture.entries().pop().unwrap()
        },
    ] {
        let mut entries = fixture.entries();
        *entries.last_mut().unwrap() = bad;
        assert_unqualified(&fixture, &[entries]);
    }
    for name in DIRS {
        for kind in [EntryType::Regular, EntryType::Link, EntryType::Symlink] {
            assert_unqualified(
                &fixture,
                &[
                    fixture.entries(),
                    vec![Member {
                        kind,
                        ..Member::file(name, b"")
                    }],
                ],
            );
        }
    }
}

#[test]
fn worker_provenance_applies_whiteouts_to_lower_state_before_same_layer_entries() {
    let fixture = Fixture::new(false);
    for whiteout in [
        "opt/reverie/human/bin/.wh.bash",
        "opt/reverie/.wh.human",
        "opt/reverie/human/bin/.wh..wh..opq",
        ".wh..wh..opq",
    ] {
        assert_unqualified(
            &fixture,
            &[fixture.entries(), vec![Member::file(whiteout, b"")]],
        );
    }
    let lower = fixture.entries();
    let mut whiteout_then_replace = fixture.entries().split_off(3);
    whiteout_then_replace.push(Member::file("opt/reverie/human/.wh.bin", b""));
    let path = fixture.archive(&[lower, whiteout_then_replace], false, false);
    assert!(fixture.qualify(&path, deadline()).is_ok());
    let path = fixture.archive(
        &[fixture.entries(), vec![Member::directory(DIRS[3])]],
        false,
        false,
    );
    assert!(fixture.qualify(&path, deadline()).is_ok());
}

#[test]
fn worker_provenance_checks_input_custody_layer_budget_and_absolute_deadline() {
    let fixture = Fixture::new(false);
    let path = fixture.archive(&[fixture.entries()], false, false);
    assert!(input::read(&path, 1 << 20, deadline()).is_err());
    assert!(fixture.qualify(&path, Instant::now()).is_err());
    let mut budget = 0;
    let mut raw = Cursor::new(layer(&fixture.entries()));
    assert!(layers::read(&mut raw, &[], &mut budget).is_err());
}
