//! Bounded CPU recognition using the pinned tiny.en graph.
use super::nonce;
use crate::{Result, audio::Wav, need};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, DirBuilder, File},
    io::{self, Read},
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{process::Command, sync::Mutex, time};

const DEADLINE: Duration = Duration::from_secs(85);
const MODEL_LIMIT: u64 = 100 * 1024 * 1024;
const TRANSCRIPT_LIMIT: u64 = 16 * 1024;

#[derive(serde::Deserialize)]
struct ModelPin {
    sha256: String,
}

pub(super) struct Whisper {
    model: PathBuf,
    root: PathBuf,
    serial: Mutex<()>,
}

impl Whisper {
    pub(super) fn open(model: PathBuf, root: &Path) -> Result<Self> {
        let pin: ModelPin = serde_json::from_str(include_str!(
            "../../../../scripts/voice-ci/whisper-model.json"
        ))?;
        let mut hash = Sha256::new();
        let mut file = File::open(&model)?;
        let info = file.metadata()?;
        need(
            info.is_file() && info.len() <= MODEL_LIMIT,
            "Invalid Whisper checkpoint",
        )?;
        let size = io::copy(&mut file.by_ref().take(MODEL_LIMIT + 1), &mut hash)?;
        need(
            size <= MODEL_LIMIT && format!("{:x}", hash.finalize()) == pin.sha256,
            "Pinned Whisper checkpoint checksum mismatch",
        )?;
        Ok(Self {
            model,
            root: root.to_owned(),
            serial: Mutex::new(()),
        })
    }

    pub(super) async fn transcribe(&self, bytes: &[u8]) -> Result<String> {
        // The browser fixture and verifier both submit measured mono WAVs.
        let wav = Wav::inspect(bytes)?;
        need(wav.duration() <= 180.0, "Speech clip is too long")?;
        time::timeout(DEADLINE, self.recognize(bytes)).await?
    }

    async fn recognize(&self, bytes: &[u8]) -> Result<String> {
        let _running = self.serial.lock().await;
        let scratch = Scratch::create(&self.root)?;
        let input = scratch.0.join("input.wav");
        let converted = scratch.0.join("16k.wav");
        let result = scratch.0.join("transcript");
        fs::write(&input, bytes)?;
        let mut ffmpeg = command(option_env!("REVERIE_VOICE_CI_FFMPEG").unwrap_or("ffmpeg"));
        ffmpeg
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "wav",
                "-i",
            ])
            .arg(input)
            .args([
                "-map",
                "0:a:0",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&converted);
        check(ffmpeg, "Could not prepare Whisper WAV").await?;
        let mut whisper = command(option_env!("REVERIE_VOICE_CI_WHISPER").unwrap_or("whisper-cli"));
        whisper
            .args([
                "-ng", "-t", "2", "-l", "en", "-tp", "0", "-nf", "-mc", "0", "-nt", "-np", "-otxt",
                "-of",
            ])
            .arg(&result)
            .arg("-m")
            .arg(&self.model)
            .arg("-f")
            .arg(converted);
        check(whisper, "Whisper transcription failed").await?;
        read_transcript(&result.with_extension("txt"))
    }
}

fn command(program: &str) -> Command {
    let mut command = Command::new(program);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    command
}

async fn check(mut command: Command, failure: &'static str) -> Result<()> {
    need(command.status().await?.success(), failure)
}

fn read_transcript(path: &Path) -> Result<String> {
    let mut text = String::new();
    let mut file = File::open(path)?.take(TRANSCRIPT_LIMIT + 1);
    file.read_to_string(&mut text)?;
    need(
        text.len() as u64 <= TRANSCRIPT_LIMIT,
        "Whisper transcript exceeds its bound",
    )?;
    Ok(text.split_whitespace().collect::<Vec<_>>().join(" "))
}

struct Scratch(PathBuf);
impl Scratch {
    fn create(root: &Path) -> Result<Self> {
        let path = root.join(format!(".recognize-{}", nonce()?));
        DirBuilder::new().mode(0o700).create(&path)?;
        Ok(Self(path))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
