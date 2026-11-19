//! Attach the verified acceptance checkpoint to the production recognizer.
use crate::{Result, audio::Wav, need};
use reverie_speech::{Format, Whisper as Recognizer};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
    time::Duration,
};

const DEADLINE: Duration = Duration::from_secs(85);
const MODEL_LIMIT: u64 = 100 * 1024 * 1024;

#[derive(serde::Deserialize)]
struct ModelPin {
    sha256: String,
}

pub(super) struct Whisper(Recognizer);

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
        Ok(Self(Recognizer::new(
            PathBuf::from(option_env!("REVERIE_SPEECH_FFMPEG").unwrap_or("ffmpeg")),
            PathBuf::from(option_env!("REVERIE_SPEECH_WHISPER").unwrap_or("whisper-cli")),
            model,
            root.to_owned(),
            2,
        )?))
    }

    pub(super) async fn transcribe(&self, bytes: &[u8]) -> Result<String> {
        let wav = Wav::inspect(bytes)?;
        need(wav.duration() <= 180.0, "Speech clip is too long")?;
        Ok(self.0.transcribe(bytes, Format::Wav, DEADLINE).await?.text)
    }
}
