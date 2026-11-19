use super::*;
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    io::Write,
    os::unix::{
        ffi::OsStringExt,
        fs::{OpenOptionsExt, PermissionsExt, symlink},
    },
};

const D2: &str = "PASS shim body = F1 r7 / native bridge r5 (shebang line excluded)\n\
PASS builder body = r5 (fixture)\nPASS cargo resolves to the shim\nPASS shim sets CARGO_BUILD_JOBS=2\n\
PASS REVERIE_NO_AUTOENV=1 untouched\nPASS explicit -j left as given\njobs=2\n";
const CAN: &str =
    "GREP pos=0 neg=1 find=0\nSHIMS /opt/reverie/autoenv/bin/cargo /shim jobs=٢\nCAN-DONE\n";
const EMPLOYEE: &str = "11111111-2222-4333-8444-555555555555";
const SESSION: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        Self(nix::unistd::mkdtemp(&std::env::temp_dir().join("reverie-offline-XXXXXX")).unwrap())
    }

    fn private(&self, name: &str, data: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap()
            .write_all(data)
            .unwrap();
        path
    }

    fn target(&self, offline: bool) -> Value {
        let image = format!("sha256:{}", "1".repeat(64));
        let cid = "a".repeat(64);
        let base = format!("/nix/store/{}-base", "a".repeat(32));
        let mut references = serde_json::Map::new();
        for (kind, text) in [("D2", D2), ("CAN", CAN)] {
            let report = self.private(&format!("{kind}.txt"), text.as_bytes());
            let mut data = json!({"version":1,"containerId":cid,"rawEvidencePath":report,
                "rawEvidenceDigest":hash(text.as_bytes())});
            if offline {
                data["imageId"] = json!(image);
                data["scope"] = json!("OFFLINE_IMAGE_TOOL_SHELL");
            } else {
                data["employeeId"] = json!(EMPLOYEE);
            }
            if kind == "D2" {
                data["jobs"] = json!(2);
            } else {
                let probe = self.private("probe", b"owned shell proof");
                data["probePath"] = json!(probe);
                data["probeDigest"] = json!(hash(b"owned shell proof"));
            }
            if !offline && kind == "CAN" {
                data["scope"] = json!("CURRENT_CODEX_TOOL_SHELL_ONLY");
                data["ownToolShell"] = json!(true);
            }
            let envelope = json!({"version":1,"kind":kind,"data":data});
            let bytes = serde_json::to_vec(&envelope).unwrap();
            let path = self.private(&format!("{kind}.json"), &bytes);
            references.insert(kind.into(), json!({"path":path,"digest":hash(&bytes)}));
        }
        let mut target = json!({
            "version":1,"kind":"reverie.worker-store-target","imageId":image,
            "engineId":"fixture","engineSocket":"/run/docker.sock","validationContainerId":cid,
            "baseTarget":base,"closurePaths":[base],"expiresAtEpoch":200,
            "cohort":[{"employeeId":EMPLOYEE,"sessionId":SESSION,"sessionGeneration":1,"employeeDigest":image}],
            "budget":{"fullClosureAllocatedBytes":1,"overheadBytes":1,"mainFloorBytes":1,"scratchFloorBytes":1},
            "receipts":references,
        });
        if offline {
            target["validationScope"] = json!("VALIDATED_OFFLINE_IMAGE_TOOL_SHELL");
        }
        target
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn hash(raw: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(raw))
}

#[test]
fn qualification_keeps_the_exact_legacy_bytes_and_custody_paths() {
    for offline in [false, true] {
        let fixture = Scratch::new();
        let target = fixture.target(offline).to_string();
        let raw = if offline {
            [0xff, 0xfe]
                .into_iter()
                .chain(target.encode_utf16().flat_map(u16::to_le_bytes))
                .collect::<Vec<_>>()
        } else {
            target.into_bytes()
        };
        let path = fixture.private("target.json", &raw);
        let qualified = inspect(&path, 100.0).unwrap();
        assert_eq!(qualified.digest, hash(&raw));
        assert_eq!(qualified.bytes, raw);
        assert_eq!(
            qualified.evidence_paths,
            ["D2.json", "D2.txt", "CAN.json", "CAN.txt", "probe"].map(|item| fixture.0.join(item))
        );
        assert!(
            inspect(&path, 200.0)
                .err()
                .unwrap()
                .to_string()
                .contains("expired")
        );
        fs::write(fixture.0.join("probe"), "changed").unwrap();
        assert!(
            inspect(&path, 100.0)
                .err()
                .unwrap()
                .to_string()
                .contains("probe bytes changed")
        );
    }
}

#[test]
fn duplicate_unknown_envelope_keys_and_unsafe_private_path_aliases_refuse() {
    let fixture = Scratch::new();
    let target = fixture.target(false);
    let actual = fixture.private("target.json", &serde_json::to_vec(&target).unwrap());
    let alias = fixture.0.join("alias.json");
    symlink(&actual, &alias).unwrap();
    assert!(inspect(&alias, 100.0).is_err());
    let linked = fixture.0.join("linked.json");
    fs::hard_link(&actual, &linked).unwrap();
    assert!(inspect(&actual, 100.0).is_err());
    fs::remove_file(linked).unwrap();

    let envelope = fs::read_to_string(fixture.0.join("CAN.json")).unwrap();
    let duplicate = format!(
        r#"{{"extra":1,"extra":2,{}}}"#,
        &envelope[1..envelope.len() - 1]
    );
    fs::write(fixture.0.join("CAN.json"), &duplicate).unwrap();
    let mut target = target;
    target["receipts"]["CAN"]["digest"] = json!(hash(duplicate.as_bytes()));
    fs::write(&actual, target.to_string()).unwrap();
    assert!(inspect(&actual, 100.0).is_err());
    fs::set_permissions(&actual, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(inspect(&actual, 100.0).is_err());
}

#[test]
fn profile_inventory_keeps_absence_and_non_unicode_symlinks_with_original_field_order() {
    let fixture = Scratch::new();
    let home = fixture.0.join("home");
    let nix = fixture.0.join("nix");
    fs::create_dir(&home).unwrap();
    fs::create_dir_all(nix.join("var/nix/gcroots")).unwrap();
    let special = OsString::from_vec(vec![b't', 0xff]);
    symlink(&special, nix.join("var/nix/gcroots").join(&special)).unwrap();
    let args = || (native::python_text(&home), native::python_text(&nix));
    let (home, nix) = args();
    let raw = inventory(&home, &nix, 6).unwrap();
    let encoded = String::from_utf8(raw).unwrap();
    assert!(encoded.starts_with(r#"{"home:.local/state/nix/profiles":{"type":"absent"},"home:.nix-profile":{"type":"absent"}"#));
    assert!(encoded.contains(r#""nix:var/nix/gcroots/t\udcff":{"identity":"#));
    assert!(encoded.contains(r#""target":"t\udcff","type":"link""#));
    assert!(inventory(&home, &nix, 4).is_err());
    let alias = fixture.0.join("home/.local");
    symlink(fixture.0.join("nix"), alias).unwrap();
    assert!(inventory(&home, &nix, 6).is_err());
}
