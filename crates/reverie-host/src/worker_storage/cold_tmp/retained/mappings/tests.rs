use super::*;
use reverie_contracts::worker_config;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    time::Duration,
};

const SESSION: &str = "00000000-0000-0000-0000-000000000000";
struct Fixture {
    root: super::super::super::tests::Fixture,
}
impl Fixture {
    fn points(&self, value: &Value) -> Vec<u32> {
        let mut points = value
            .as_array()
            .unwrap()
            .iter()
            .map(|value| u32::try_from(value.as_u64().unwrap()).unwrap())
            .collect::<Vec<_>>();
        let marker = "@ROOT".chars().map(u32::from).collect::<Vec<_>>();
        if points.starts_with(&marker) {
            points.splice(..marker.len(), native::python_text(&self.root.path));
        }
        points
    }
    fn path(&self, value: &Value) -> PathBuf {
        native::python_path(&self.points(value)).unwrap()
    }
    fn mappings(&self, mounts: &Value) -> Mappings {
        let mounts = mounts.as_array().unwrap().iter().map(|mount| {
            json!({"source":self.path(&mount["source"]),
                "destination":String::from_iter(self.points(&mount["destination"]).into_iter().map(|point|char::from_u32(point).unwrap()))})
        }).collect::<Vec<_>>();
        let source = worker_config::decode(&serde_json::to_vec(&json!({
            "uid":native::uid(),"companyFile":self.root.path.join("company.json"),
            "stateRoot":self.root.path.join("state"),"scratchRoot":self.root.path.join("scratch"),
            "mounts":mounts,"coldTemporaryCleanup":{"version":1,"enabled":true,
                "strategy":"retain-and-replace","hostLeaseDirectories":[]}
        })).unwrap()).unwrap();
        let config = Configuration::capture(&source).unwrap();
        let paths = storage_identity::storage_paths(
            &config.identity,
            &ProfileSessionId::parse(SESSION).unwrap(),
        )
        .unwrap();
        Mappings::capture(
            &config,
            &paths,
            &ColdConfiguration::capture(&source).unwrap().unwrap(),
        )
        .unwrap()
    }
}

#[test]
fn actual_python_guest_mappings_keep_symlink_namespace_ambiguity_and_raw_keys() {
    let oracle: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/cold-tmp/retained-mapping-python.json"
    )))
    .unwrap();
    let fixture = Fixture {
        root: super::super::super::tests::Fixture::new(),
    };
    for directory in oracle["directories"].as_array().unwrap() {
        fs::create_dir_all(fixture.path(directory)).unwrap();
    }
    for link in oracle["links"].as_array().unwrap() {
        symlink(fixture.path(&link["target"]), fixture.path(&link["path"])).unwrap();
    }
    let company = fixture.root.path.join("company.json");
    fs::write(&company, br#"{"employees":[]}"#).unwrap();
    fs::set_permissions(&company, fs::Permissions::from_mode(0o600)).unwrap();
    let marker = fixture
        .root
        .path
        .join("scratch")
        .join(SESSION)
        .join("tmp/.keep");
    fs::write(&marker, b"must not inspect the old tree").unwrap();
    let cases = oracle["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 28);
    for case in cases {
        let mappings = fixture.mappings(&case["mounts"]);
        let target = fs::metadata(fixture.path(&case["keyTarget"])).unwrap();
        let key = format!("{}-{}", target.dev(), target.ino());
        let key = match case["keyStyle"].as_str().unwrap() {
            "normal" => key,
            "zero" => format!("0{key}"),
            "wrong" => "0-0".into(),
            _ => panic!("key style"),
        };
        let recorded = PosixPath::try_new(&fixture.points(&case["recorded"])).unwrap();
        let result = mappings.candidates(&recorded, &key, Instant::now() + Duration::from_secs(5));
        if case["error"].is_null() {
            let expected = case["result"]
                .as_array()
                .unwrap()
                .iter()
                .map(|path| PosixPath::try_new(&fixture.points(path)).unwrap())
                .collect::<Vec<_>>();
            assert_eq!(result.unwrap(), expected, "{}", case["label"]);
        } else {
            assert!(result.is_err(), "{}", case["label"]);
        }
    }
    assert_eq!(fs::read(marker).unwrap(), b"must not inspect the old tree");
}
