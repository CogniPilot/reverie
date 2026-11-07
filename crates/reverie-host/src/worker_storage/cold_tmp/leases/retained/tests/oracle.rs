use super::*;
use serde_json::Value;

struct Keys {
    target: String,
    other: String,
}
impl Keys {
    fn new(fixture: &Fixture) -> Self {
        let key = |path: PathBuf| {
            let info = stdfs::metadata(path).unwrap();
            format!("{}-{}", info.dev(), info.ino())
        };
        Self {
            target: key(fixture.target()),
            other: key(fixture.root.path.join("shared")),
        }
    }
    fn expand(&self, text: &str) -> String {
        text.replace("@OTHERKEY", &self.other)
            .replace("@KEY", &self.target)
    }
}
fn raw(entry: &Value) -> Vec<u8> {
    let text = entry["raw"].as_str().unwrap();
    match entry["encoding"].as_str().unwrap() {
        "utf-8" => text.as_bytes().to_vec(),
        "utf-8-sig" => [b"\xef\xbb\xbf".as_slice(), text.as_bytes()].concat(),
        "utf-16" => std::iter::once(0xfeff)
            .chain(text.encode_utf16())
            .flat_map(u16::to_le_bytes)
            .collect(),
        "utf-32" => std::iter::once(0xfeff)
            .chain(text.chars().map(u32::from))
            .flat_map(u32::to_le_bytes)
            .collect(),
        _ => panic!("oracle encoding"),
    }
}
fn populate(fixture: &Fixture, keys: &Keys, case: &Value) {
    let outside = fixture.root.path.join("outside-record");
    stdfs::write(&outside, br#"{"version":1,"path":"/tmp"}"#).unwrap();
    stdfs::set_permissions(&outside, stdfs::Permissions::from_mode(0o600)).unwrap();
    for entry in case["files"].as_array().unwrap() {
        let name = keys.expand(entry["name"].as_str().unwrap());
        let path = fixture.base().join(&name);
        let mode = u32::try_from(entry["mode"].as_u64().unwrap()).unwrap();
        match entry["kind"].as_str().unwrap() {
            "file" => {
                fixture.write(&name, &raw(entry));
                stdfs::set_permissions(path, stdfs::Permissions::from_mode(mode)).unwrap();
            }
            "symlink" => symlink(&outside, path).unwrap(),
            "hardlink" => stdfs::hard_link(&outside, path).unwrap(),
            "fifo" => {
                nix::unistd::mkfifo(&path, nix::sys::stat::Mode::from_bits(mode).unwrap()).unwrap()
            }
            _ => panic!("oracle file kind"),
        }
    }
}
#[test]
fn actual_unchanged_python_retirement_inventory_matches_all_43_owned_cases() {
    let oracle: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/cold-tmp/retirement-python.json"
    )))
    .unwrap();
    let cases = oracle["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 43);
    for case in cases {
        let fixture = Fixture::new();
        let keys = Keys::new(&fixture);
        populate(&fixture, &keys, case);
        let mut holders = case["held"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| {
                let name = keys.expand(name.as_str().unwrap());
                let file =
                    fixture.open_lock(name.strip_suffix(".lock").expect("fixed oracle lock"));
                file.try_lock_shared().unwrap();
                file
            })
            .collect::<Vec<_>>();
        let scope = fixture.scope();
        let mut bases = fixture.capture();
        bases.barriers(fixture.end()).unwrap();
        let result = bases.retained_locks(&scope, fixture.end());
        // Settle every actual kernel-lock owner before asserting a mismatch.
        bases.close().unwrap();
        while let Some(file) = holders.pop() {
            native::close(file).unwrap();
        }
        if case["error"].is_null() {
            let inventory = result.unwrap_or_else(|error| panic!("{}: {error}", case["label"]));
            assert_eq!(
                inventory.registered as u64,
                case["result"]["registeredRecords"].as_u64().unwrap(),
                "{}",
                case["label"]
            );
            assert_eq!(
                inventory.relevant as u64,
                case["result"]["relevantKeys"].as_u64().unwrap(),
                "{}",
                case["label"]
            );
        } else {
            assert!(result.is_err(), "{}", case["label"]);
        }
        assert_eq!(
            stdfs::read(fixture.target().join(".keep")).unwrap(),
            b"old data never inventoried"
        );
    }
}
