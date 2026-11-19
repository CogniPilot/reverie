//! Journal real engine lock and inference events for the browser fixture.
use super::nonce;
use crate::{Result, audio::Wav, need};
use bytes::Bytes;
use nix::time::{ClockId, clock_gettime};
use reverie_kokoro::{Engine, Voice};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

pub(super) struct Speech {
    engine: Arc<AsyncMutex<Engine>>,
    voices: Vec<Voice>,
    journal: Arc<Journal>,
    default_voice: String,
}

pub(super) enum Outcome {
    Ready { audio: Bytes, raw: bool },
    Busy,
}

#[derive(Deserialize)]
struct Payload {
    text: String,
    #[serde(default)]
    voice: Option<String>,
}

struct Journal {
    progress: Mutex<File>,
    results: Mutex<File>,
}

fn log(path: &Path) -> Result<Mutex<File>> {
    Ok(Mutex::new(
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path)?,
    ))
}

fn entry(file: &Mutex<File>, data: &Value) -> Result<()> {
    let mut file = file.lock().map_err(|_| "Speech journal lock poisoned")?;
    writeln!(&mut file, "{data}")?;
    Ok(())
}

pub(super) fn now() -> Result<u64> {
    nanos(ClockId::CLOCK_MONOTONIC)
}

fn nanos(clock: ClockId) -> Result<u64> {
    let instant = clock_gettime(clock)?;
    let seconds = u64::try_from(instant.tv_sec())?;
    let nanos = u64::try_from(instant.tv_nsec())?;
    seconds
        .checked_mul(1_000_000_000)
        .and_then(|base| base.checked_add(nanos))
        .ok_or_else(|| "Clock value exceeds its bound".into())
}

impl Speech {
    pub(super) fn new(engine: Engine, root: &Path, default_voice: String) -> Result<Self> {
        let voices = engine.voices();
        need(
            voices.iter().any(|voice| voice.id() == default_voice),
            "Fixture voice is unavailable",
        )?;
        let journal = Journal {
            progress: log(&root.join("speech-requests.jsonl"))?,
            results: log(&root.join("synth-events.jsonl"))?,
        };
        Ok(Self {
            engine: Arc::new(AsyncMutex::new(engine)),
            voices,
            journal: Arc::new(journal),
            default_voice,
        })
    }

    pub(super) fn voices(&self) -> &[Voice] {
        &self.voices
    }

    pub(super) async fn synthesize(&self, payload: &[u8], started: u64) -> Result<Outcome> {
        let payload: Payload = serde_json::from_slice(payload)?;
        let selected = payload
            .voice
            .as_deref()
            .filter(|voice| !voice.is_empty())
            .unwrap_or(&self.default_voice);
        let mut request = Request::new(
            selected.to_owned(),
            payload,
            started,
            Arc::clone(&self.journal),
        )?;
        request.phase("synthesis-start")?;
        request.timing["lockAttemptNs"] = json!(now()?);
        let Ok(engine) = Arc::clone(&self.engine).try_lock_owned() else {
            return request.busy();
        };
        request.timing["acquiredNs"] = json!(now()?);
        tokio::task::spawn_blocking(move || request.run(engine)).await?
    }
}

struct Request {
    id: String,
    started: u64,
    text: String,
    characters: usize,
    hash: String,
    requested: Option<String>,
    selected: String,
    timing: Value,
    journal: Arc<Journal>,
}

impl Request {
    fn new(
        selected: String,
        payload: Payload,
        started: u64,
        journal: Arc<Journal>,
    ) -> Result<Self> {
        Ok(Self {
            id: nonce()?,
            started,
            characters: payload.text.chars().count(),
            hash: format!("{:x}", Sha256::digest(payload.text.as_bytes())),
            text: payload.text,
            requested: payload.voice,
            selected,
            timing: json!({}),
            journal,
        })
    }

    fn phase(&self, phase: &str) -> Result<()> {
        entry(
            &self.journal.progress,
            &json!({
                "requestId":self.id,"requestNs":self.started,"effectiveVoice":self.selected,
                "textCharacters":self.characters,"textSha256":self.hash,"phase":phase,
                "atNs":now()?,"processCpuNs":nanos(ClockId::CLOCK_PROCESS_CPUTIME_ID)?,"timing":self.timing,
            }),
        )
    }

    fn result(&self, status: &str, bytes: Option<&[u8]>) -> Result<()> {
        let mut data = json!({
            "requestNs":self.started,"responseNs":now()?,"status":status,"timing":self.timing,
            "text":self.text,"requestedVoice":self.requested,"effectiveVoice":self.selected,"provider":"kokoro",
        });
        if let Some(bytes) = bytes {
            let report = Wav::inspect(bytes)?.report();
            for (key, value) in report.as_object().ok_or("Invalid WAV facts")? {
                data[key] = value.clone();
            }
            data["bytes"] = json!(bytes.len());
        }
        entry(&self.journal.results, &data)
    }

    fn busy(mut self) -> Result<Outcome> {
        self.timing["status"] = json!("busy");
        self.timing["finishedNs"] = json!(now()?);
        self.phase("synthesis-raised")?;
        self.result("busy", None)?;
        Ok(Outcome::Busy)
    }

    fn run(mut self, mut engine: OwnedMutexGuard<Engine>) -> Result<Outcome> {
        self.timing["status"] = json!("failed");
        self.timing["inferenceStartNs"] = json!(now()?);
        self.phase("inference-start")?;
        let result = engine.synthesize(&self.text, &self.selected);
        if result.as_ref().is_ok_and(Option::is_some) {
            self.timing["inferenceEndNs"] = json!(now()?);
            self.phase("inference-end")?;
            self.timing["status"] = json!("completed");
        }
        self.timing["finishedNs"] = json!(now()?);
        drop(engine);
        match result {
            Ok(Some(bytes)) => {
                self.phase("synthesis-return")?;
                self.result("completed", Some(&bytes))?;
                let raw = self
                    .requested
                    .as_deref()
                    .is_some_and(|voice| !voice.is_empty());
                Ok(Outcome::Ready {
                    audio: Bytes::from(bytes),
                    raw,
                })
            }
            failure => {
                self.phase("synthesis-raised")?;
                self.result("failed", None)?;
                Err(failure
                    .err()
                    .unwrap_or_else(|| "Nothing to synthesize".into()))
            }
        }
    }
}
