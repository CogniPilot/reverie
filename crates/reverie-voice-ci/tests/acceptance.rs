mod fixture;
mod transport;

use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

#[test]
fn native_acceptance_and_refusal_match_the_unchanged_oracle() {
    // Optional parent oracle is the existing, unchanged Python entry point.
    // CI always executes the native cases; a local retirement qualification
    // additionally sets REVERIE_VOICE_CI_PARENT to the exact parent checkout.
    let parent = std::env::var_os("REVERIE_VOICE_CI_PARENT");
    for case in [
        "pass",
        "voice",
        "timing",
        "browser",
        "silent",
        "short",
        "endpoint",
        "http",
        "json",
        "empty-asr",
        "asr-negative",
    ] {
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
        if let Some(parent) = &parent {
            let oracle = fixture::Artifacts::new(case, &server.url());
            let before = Command::new("python3")
                .arg(Path::new(parent).join("scripts/voice-ci/verify.py"))
                .arg("--artifacts")
                .arg(&oracle.path)
                .output()
                .expect("parent oracle");
            assert_eq!(
                before.status.success(),
                result.status.success(),
                "oracle {case}: {before:?}"
            );
            compare(&native.path, &oracle.path, &result, &before);
            retain(&oracle.path, &before);
            eprintln!("parent/native parity PASS: {case}");
        }
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

fn compare(native: &Path, oracle: &Path, result: &Output, before: &Output) {
    for name in ["acceptance.json", "audio-report.json"] {
        let left = native.join(name);
        let right = oracle.join(name);
        assert_eq!(left.exists(), right.exists(), "{name}");
        if left.exists() {
            assert_eq!(
                without_time(json_file(&left)),
                without_time(json_file(&right)),
                "{name}"
            );
        }
    }
    for name in [
        "speak.wav.transcript.txt",
        "turn.wav.transcript.txt",
        "negative-ten-seconds.wav",
        "negative-ten-seconds.transcript.txt",
    ] {
        let left = native.join(name);
        let right = oracle.join(name);
        assert_eq!(left.exists(), right.exists(), "{name}");
        if left.exists() {
            assert_eq!(fs::read(left).unwrap(), fs::read(right).unwrap(), "{name}");
        }
    }
    let phases = |out: &Output| -> Vec<Value> {
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|line| without_time(serde_json::from_str(line).expect("progress JSON")))
            .collect()
    };
    assert_eq!(phases(result), phases(before));
}

fn json_file(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn without_time(mut value: Value) -> Value {
    match &mut value {
        Value::Object(object) => {
            object.remove("recognitionMs");
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
