//! The Rust GET /api/settings handler against the TS route's recorded answers. The TS recorder
//! (apps/web/test/routes/settings-rust-goldens.test.ts) reads the same cases.json and wrote
//! goldens.json from the real route, response envelope and error handler. Every case must match
//! byte for byte, except the declared bounds, which must refuse with exactly their declared code.
use reverie_contracts::settings_v1::ContentType;
use reverie_routes::settings;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

const CASES: &str = include_str!("fixtures/settings/cases.json");
const GOLDENS: &str = include_str!("fixtures/settings/goldens.json");

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn number(value: &Value, key: &str) -> usize {
    value[key].as_u64().expect(key) as usize
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex"))
        .collect()
}

/// The file's bytes, generated exactly as the TS recorder generates them.
fn contents(case: &Value) -> Vec<u8> {
    if let Some(bytes) = text(case, "hex") {
        return hex(bytes);
    }
    if let Some(nest) = case.get("nest") {
        let depth = number(nest, "depth");
        let open = text(nest, "open").expect("open").repeat(depth);
        let close = text(nest, "close").expect("close").repeat(depth);
        return format!("{open}{}{close}", text(nest, "inner").unwrap_or("")).into_bytes();
    }
    if let Some(fill) = case.get("fill") {
        let prefix = text(fill, "prefix").expect("prefix");
        let suffix = text(fill, "suffix").expect("suffix");
        let count = number(fill, "bytes") - prefix.len() - suffix.len();
        let body = text(fill, "char").expect("char").repeat(count);
        return format!("{prefix}{body}{suffix}").into_bytes();
    }
    text(case, "text").unwrap_or("").as_bytes().to_vec()
}

/// Removes every permission, so opening fails for an unprivileged reader. The file holds invalid
/// JSON, so a reader that can still open it (a privileged one, or any reader off unix) answers the
/// same default.
#[cfg(unix)]
fn deny(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o000)).expect("chmod");
}
#[cfg(not(unix))]
fn deny(_: &Path) {}

/// Creates the case's file under `root` and returns the path the forwarder would send.
fn materialize(root: &Path, case: &Value) -> String {
    fs::create_dir_all(root.join("data")).expect("data dir");
    let absolute = root.join("data").join("settings.json");
    match text(case, "kind").expect("kind") {
        "missing" => {}
        "dir" => fs::create_dir(&absolute).expect("dir"),
        "file" | "unreadable" => fs::write(&absolute, contents(case)).expect("file"),
        other => panic!("unknown kind {other}"),
    }
    if text(case, "kind") == Some("unreadable") {
        deny(&absolute);
    }
    if case.get("relative").and_then(Value::as_bool) == Some(true) {
        // The case root is this test's working directory for the relative case only.
        "data/settings.json".to_string()
    } else {
        absolute.to_string_lossy().into_owned()
    }
}

#[test]
fn every_case_matches_the_ts_route() {
    let cases: Value = serde_json::from_str(CASES).expect("cases JSON");
    let goldens: Value = serde_json::from_str(GOLDENS).expect("goldens JSON");
    let base = std::env::temp_dir().join(format!("settings-goldens-{}", std::process::id()));
    for case in cases["cases"].as_array().expect("cases") {
        let name = text(case, "name").expect("name");
        let root = base.join(name);
        let path = materialize(&root, case);
        let relative = case.get("relative").and_then(Value::as_bool) == Some(true);
        let previous = std::env::current_dir().expect("cwd");
        if relative {
            std::env::set_current_dir(&root).expect("chdir");
        }
        let request = serde_json::json!({ "settingsPath": path }).to_string();
        let outcome = settings::answer(request.as_bytes());
        if relative {
            std::env::set_current_dir(previous).expect("chdir back");
        }
        if let Some(deviation) = text(case, "deviation") {
            assert_eq!(
                outcome.map_err(|refusal| refusal.code()),
                Err(deviation),
                "{name}"
            );
            continue;
        }
        let response = outcome.unwrap_or_else(|refusal| panic!("{name}: {}", refusal.code()));
        let golden = &goldens["cases"][name];
        assert_eq!(
            u64::from(response.status),
            golden["status"].as_u64().expect("status"),
            "{name}"
        );
        let content_type = match response.content_type {
            ContentType::Json => "application/json; charset=utf-8",
            ContentType::PlainText => "text/plain; charset=utf-8",
        };
        assert_eq!(Some(content_type), text(golden, "contentType"), "{name}");
        match text(golden, "bodyHex") {
            Some(body) => assert_eq!(response.body, hex(body), "{name}"),
            None => {
                assert_eq!(response.body.len(), number(golden, "bodyLength"), "{name}");
                let digest: String = Sha256::digest(&response.body)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                assert_eq!(Some(digest.as_str()), text(golden, "bodySha256"), "{name}");
            }
        }
    }
    let _ = fs::remove_dir_all(base);
}
