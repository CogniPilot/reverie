use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};

pub(super) const FIXTURE: &str = include_str!("../../../../scripts/voice-ci/fixtures.json");
static NEXT: AtomicUsize = AtomicUsize::new(0);

pub(super) struct Artifacts {
    pub(super) path: PathBuf,
}

impl Artifacts {
    pub(super) fn new(case: &str, base: &str) -> Self {
        let number = NEXT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::var_os("REVERIE_VOICE_CI_EVIDENCE")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let path = root.join(format!(
            "voice-ci-parity-{case}-{}-{number}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("fresh artifacts");
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        let voice = json!({"provider":"kokoro", "id":fixture["voice"]});
        let mut clips = json!([
            {"endpoint":"speak","file":"speak.wav","expected":fixture["reply"],"voice":voice},
            {"endpoint":"turn","file":"turn.wav","expected":fixture["reply"]}
        ]);
        if case == "voice" {
            clips[0]["voice"]["id"] = json!("wrong");
        }
        if case == "endpoint" {
            clips.as_array_mut().unwrap().push(json!({"endpoint":null}));
        }
        fs::write(path.join("speech-url.txt"), base).unwrap();
        write(&path, "clips.json", &clips);
        let seconds = if case == "short" { 10 } else { 20 };
        let wav = wav(seconds, if case == "silent" { 0 } else { 1000 });
        for name in ["speak", "turn"] {
            fs::write(path.join(format!("{name}.wav")), &wav).unwrap();
            write(
                &path,
                &format!("{name}.browser.json"),
                &json!({"duration":
                if case == "browser" { 100 } else { seconds }}),
            );
        }
        write(&path, "turn.json", &json!({"transcript":fixture["input"]}));
        let mut event = json!({"provider":"kokoro","effectiveVoice":fixture["voice"],
            "status":"completed","requestNs":1,"responseNs":9,
            "timing":{"status":"completed","lockAttemptNs":2,"acquiredNs":3,
                "inferenceStartNs":4,"inferenceEndNs":5,"finishedNs":6}});
        if case == "timing" {
            event["timing"]["inferenceEndNs"] = json!(4);
        }
        fs::write(path.join("synth-events.jsonl"), format!("{event}\n")).unwrap();
        Self { path }
    }
}

impl Drop for Artifacts {
    fn drop(&mut self) {
        if std::env::var_os("REVERIE_VOICE_CI_EVIDENCE").is_none() {
            fs::remove_dir_all(&self.path).expect("owned fixture cleanup");
        }
    }
}

fn write(root: &std::path::Path, name: &str, value: &Value) {
    fs::write(root.join(name), serde_json::to_vec(value).unwrap()).unwrap();
}

fn wav(seconds: u32, signal: i16) -> Vec<u8> {
    let size = seconds * 8000 * 2;
    let mut bytes = Vec::new();
    bytes.extend(b"RIFF");
    bytes.extend((size + 36).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16_u32.to_le_bytes());
    bytes.extend(1_u16.to_le_bytes());
    bytes.extend(1_u16.to_le_bytes());
    bytes.extend(8000_u32.to_le_bytes());
    bytes.extend(16000_u32.to_le_bytes());
    bytes.extend(2_u16.to_le_bytes());
    bytes.extend(16_u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend(size.to_le_bytes());
    for _ in 0..size / 2 {
        bytes.extend(signal.to_le_bytes());
    }
    bytes
}
