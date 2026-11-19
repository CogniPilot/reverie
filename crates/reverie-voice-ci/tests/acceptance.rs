mod fixture;
mod transport;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    process::{Command, Output},
};

#[test]
fn native_acceptance_and_refusal_match_the_recorded_contract() {
    let expected: BTreeMap<&str, &str> =
        serde_json::from_str(include_str!("fixture/acceptance-contract.json")).unwrap();
    for (case, digest) in expected {
        let server = transport::Server::start(case);
        let native = fixture::Artifacts::new(case, &server.url());
        let result = Command::new(env!("CARGO_BIN_EXE_reverie-voice-ci-verify"))
            .arg("--artifacts")
            .arg(&native.path)
            .output()
            .expect("native verifier");
        assert_eq!(
            result.status.success(),
            case == "pass",
            "{case}: {result:?}"
        );
        assert_eq!(native.path.join("acceptance.json").exists(), case == "pass");
        retain(&native.path, &result);
        let observed = contract(&native.path, &result);
        let actual = hash(&serde_json::to_vec(&observed).unwrap());
        assert_eq!(actual, digest, "{case}: {observed}");
    }
}

fn retain(root: &Path, output: &Output) {
    fs::write(root.join("verifier.stdout"), &output.stdout).unwrap();
    fs::write(root.join("verifier.stderr"), &output.stderr).unwrap();
    fs::write(
        root.join("verifier.exit.json"),
        serde_json::json!({
            "success":output.status.success(),"code":output.status.code()
        })
        .to_string(),
    )
    .unwrap();
}

fn contract(root: &Path, output: &Output) -> Value {
    let files: BTreeMap<_, _> = [
        "speak.wav.transcript.txt",
        "turn.wav.transcript.txt",
        "negative-ten-seconds.wav",
        "negative-ten-seconds.transcript.txt",
    ]
    .into_iter()
    .map(|name| (name, root.join(name)))
    .filter(|(_, path)| path.exists())
    .map(|(name, path)| (name, hash(&fs::read(path).unwrap())))
    .collect();
    let progress: Vec<Value> = std::str::from_utf8(&output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).expect("progress JSON"))
        .collect();
    let mut value = without_time(json!({
        "success": output.status.success(),
        "receipt": json_file(&root.join("acceptance.json")),
        "report": json_file(&root.join("audio-report.json")),
        "progress": progress,
        "files": files,
    }));
    value.sort_all_objects();
    value
}

fn json_file(path: &Path) -> Value {
    if path.exists() {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    } else {
        Value::Null
    }
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn without_time(mut value: Value) -> Value {
    match &mut value {
        Value::Object(object) => {
            object.remove("recognitionMs");
            for value in object.values_mut() {
                *value = without_time(value.take());
            }
        }
        Value::Array(values) => {
            for value in values {
                *value = without_time(value.take());
            }
        }
        _ => {}
    }
    value
}
