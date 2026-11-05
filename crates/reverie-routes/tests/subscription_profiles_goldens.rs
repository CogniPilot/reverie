//! Each case in fixtures/subscription-profiles/cases.json must produce the bytes the TS route recorded in
//! goldens.json (apps/web/test/routes/subscription-profiles-rust-goldens.test.ts checks the same files).
//! The handler implements Node `path.posix` only, so a win32 front is refused on every OS.
use reverie_contracts::subscription_profiles_v1::{Refusal, decode_request};
use reverie_routes::subscription_profiles::{Read, read};
use serde_json::{Value, json};

fn request(platform: &str, data_dir: &str) -> Value {
    json!({
        "env": {},
        "home": "/h",
        "cwd": "/",
        "platform": platform,
        "dataDir": data_dir,
    })
}

fn decoded(value: &Value) -> Result<reverie_contracts::subscription_profiles_v1::Request, Refusal> {
    decode_request(&serde_json::to_vec(value).expect("request JSON"))
}

#[test]
fn refuses_requests_ts_has_no_reply_for() {
    let win32 = decoded(&request("win32", "/d")).expect("decodes");
    assert_eq!(read(&win32), Err(Refusal::Platform));
    let mut unknown = request("linux", "/d");
    unknown["extra"] = json!(1);
    assert_eq!(decoded(&unknown), Err(Refusal::RequestSchema));
    let mut missing = request("linux", "/d");
    missing.as_object_mut().expect("object").remove("cwd");
    assert_eq!(decoded(&missing), Err(Refusal::RequestSchema));
    assert_eq!(
        decode_request(&vec![b' '; 64 * 1024 + 1]),
        Err(Refusal::RequestBound)
    );
}

#[cfg(unix)]
mod posix {
    use super::{Read, Value, decoded, json, read, request};
    use reverie_contracts::subscription_profiles_v1::{
        CONTENT_TYPE, MAX_FILE_BYTES, Refusal, Response, decode_modes,
    };
    use reverie_routes::subscription_profiles::finish;
    use std::fs;
    use std::io::ErrorKind;
    use std::os::unix::fs::{DirBuilderExt, symlink};
    use std::path::{Path, PathBuf};

    const FIXTURES: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/subscription-profiles"
    );

    fn load(name: &str) -> Value {
        serde_json::from_slice(&fs::read(Path::new(FIXTURES).join(name)).expect("fixture"))
            .expect("fixture JSON")
    }

    fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
        value.get(key).and_then(Value::as_str)
    }

    fn hex(digits: &str) -> Vec<u8> {
        (0..digits.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&digits[at..at + 2], 16).expect("hex fixture"))
            .collect()
    }

    /// A root this test created itself under `base`. `create` fails when the name exists, so a
    /// pre-existing path is never adopted or later removed; the next attempt name is tried instead.
    fn temp_root_in(base: &Path, label: &str) -> PathBuf {
        for attempt in 0..100 {
            let root = base.join(format!(
                "sp-golden-{}-{label}-{attempt}",
                std::process::id()
            ));
            match fs::DirBuilder::new().mode(0o700).create(&root) {
                Ok(()) => {
                    fs::create_dir(root.join("home")).expect("home");
                    fs::create_dir(root.join("data")).expect("data");
                    return root;
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
                Err(error) => panic!("temp root: {error}"),
            }
        }
        panic!("no unused temp root name");
    }

    fn temp_root(label: &str) -> PathBuf {
        temp_root_in(&std::env::temp_dir(), label)
    }

    fn materialize(root: &Path, tree: &[Value]) {
        let root_text = root.to_str().expect("UTF-8 temp root");
        for entry in tree {
            let path = root.join(text(entry, "path").expect("entry path"));
            fs::create_dir_all(path.parent().expect("parent")).expect("parent dir");
            if entry.get("dir") == Some(&Value::Bool(true)) {
                fs::create_dir_all(&path).expect("dir");
            } else if let Some(target) = text(entry, "symlink") {
                symlink(target.replace("<ROOT>", root_text), &path).expect("symlink");
            } else {
                let bytes = text(entry, "hex").map_or_else(
                    || text(entry, "text").unwrap_or("").as_bytes().to_vec(),
                    hex,
                );
                fs::write(&path, bytes).expect("file");
            }
        }
    }

    /// HOME is <root>/home, the data dir <root>/data and the TS cwd <root>, as in the TS capture.
    fn case_request(root: &Path, case: &Value) -> Value {
        let root_text = root.to_str().expect("UTF-8 temp root");
        let mut env = serde_json::Map::new();
        for (key, value) in case["env"].as_object().expect("env") {
            let value = value
                .as_str()
                .expect("env value")
                .replace("<ROOT>", root_text);
            env.insert(key.clone(), Value::String(value));
        }
        json!({
            "env": env,
            "home": format!("{root_text}/home"),
            "cwd": root_text,
            "platform": std::env::consts::OS,
            "dataDir": format!("{root_text}/data"),
        })
    }

    /// Answers a modes observation as TS does: exactly the requested providers' recorded lists.
    fn respond(read: Read, modes: &Value) -> Response {
        let pending = match read {
            Read::Done(response) => return response,
            Read::NeedModes(pending) => pending,
        };
        let providers = pending.providers();
        let observed: serde_json::Map<String, Value> = providers
            .iter()
            .map(|provider| {
                (
                    provider.as_str().to_string(),
                    modes[provider.as_str()].clone(),
                )
            })
            .collect();
        let raw = serde_json::to_vec(&observed).expect("observed JSON");
        let modes = decode_modes(&raw, &providers).expect("observed modes");
        finish(pending, &modes).expect("finished")
    }

    #[test]
    fn rust_handler_matches_ts_goldens() {
        let cases = load("cases.json");
        let cases = cases["cases"].as_array().expect("cases");
        let goldens = load("goldens.json");
        assert_eq!(
            goldens["cases"].as_object().expect("golden cases").len(),
            cases.len()
        );
        let mut mismatches = Vec::new();
        for (index, case) in cases.iter().enumerate() {
            let name = text(case, "name").expect("case name");
            let golden = &goldens["cases"][name];
            let root = temp_root(&index.to_string());
            materialize(&root, case["tree"].as_array().expect("tree"));
            let request = decoded(&case_request(&root, case)).expect("decodes");
            let response = respond(read(&request).expect("handled"), &goldens["modes"]);
            let body = String::from_utf8(response.body).expect("UTF-8 body");
            let body = body.replace(root.to_str().expect("UTF-8 temp root"), "<ROOT>");
            fs::remove_dir_all(&root).expect("cleanup");
            if Some(u64::from(response.status)) != golden["status"].as_u64()
                || Some(body.as_str()) != text(golden, "body")
                || Some(CONTENT_TYPE) != text(golden, "contentType")
            {
                mismatches.push(format!("{name}: {} {body}", response.status));
            }
        }
        assert!(
            mismatches.is_empty(),
            "{} mismatches:\n{}",
            mismatches.len(),
            mismatches.join("\n")
        );
    }

    #[test]
    fn refuses_a_file_over_the_bound() {
        let root = temp_root("bound");
        let data = root.join("data");
        fs::write(
            data.join("subscription-profiles.json"),
            vec![b' '; MAX_FILE_BYTES + 1],
        )
        .expect("big file");
        let big =
            decoded(&request("linux", data.to_str().expect("UTF-8 temp root"))).expect("decodes");
        assert_eq!(read(&big), Err(Refusal::FileBound));
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn fixture_root_never_adopts_an_existing_path() {
        let base = temp_root("collision-base");
        let taken = base.join(format!("sp-golden-{}-collide-0", std::process::id()));
        fs::create_dir(&taken).expect("pre-existing candidate");
        fs::write(taken.join("sentinel"), b"not ours").expect("sentinel");
        let root = temp_root_in(&base, "collide");
        assert_ne!(root, taken);
        fs::remove_dir_all(&root).expect("cleanup");
        assert_eq!(
            fs::read(taken.join("sentinel")).expect("sentinel kept"),
            b"not ours"
        );
        assert_eq!(fs::read_dir(&taken).expect("candidate kept").count(), 1);
        fs::remove_dir_all(&base).expect("cleanup");
    }
}
