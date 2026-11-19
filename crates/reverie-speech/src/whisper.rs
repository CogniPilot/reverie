use crate::{
    Format, Result, media,
    process::{self, Scratch},
};
use regex_lite::Regex;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};
use tokio::{sync::Mutex, time};

const SPEECH_LIMIT: usize = 5_830_000;
const MODEL_LIMIT: u64 = 4 * 1024 * 1024 * 1024;
const DEMUXERS: &str = "wav,matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,ogg,mp3,aac,flac";

pub struct Transcript {
    pub text: String,
    pub duration_ms: u64,
}

pub struct Whisper {
    ffmpeg: PathBuf,
    whisper: PathBuf,
    model: PathBuf,
    scratch: PathBuf,
    threads: u8,
    serial: Mutex<()>,
}

impl Whisper {
    pub fn new(
        ffmpeg: PathBuf,
        whisper: PathBuf,
        model: PathBuf,
        scratch: PathBuf,
        threads: u8,
    ) -> Result<Self> {
        if !(1..=32).contains(&threads) {
            return Err("Whisper threads must be between 1 and 32".into());
        }
        Ok(Self {
            ffmpeg: process::executable(ffmpeg),
            whisper: process::executable(whisper),
            model: std::path::absolute(model)?,
            scratch: std::path::absolute(scratch)?,
            threads,
            serial: Mutex::new(()),
        })
    }

    pub fn ready(&self) -> bool {
        self.ffmpeg.is_file() && self.whisper.is_file() && process::asset(&self.model, MODEL_LIMIT)
    }

    pub async fn transcribe(
        &self,
        bytes: &[u8],
        format: Format,
        deadline: Duration,
    ) -> Result<Transcript> {
        time::timeout(deadline, self.recognize(bytes, format)).await?
    }

    async fn recognize(&self, bytes: &[u8], format: Format) -> Result<Transcript> {
        let _running = self.serial.lock().await;
        if !self.ready() {
            return Err("Whisper model or executable is unavailable".into());
        }
        let scratch = Scratch::create(&self.scratch)?;
        let input = scratch.file("recording");
        let wave = scratch.file("converted.wav");
        fs::write(&input, bytes)?;
        self.convert(&input, &wave, format).await?;
        let wave_bytes = process::read(&wave, SPEECH_LIMIT)?;
        let duration_ms =
            media::decoded_milliseconds(&wave_bytes).ok_or("Invalid decoded recording")?;
        if duration_ms == 0 {
            return Ok(Transcript {
                text: String::new(),
                duration_ms,
            });
        }
        if duration_ms > 180_000 {
            return Err("Recording exceeds three minutes".into());
        }
        let text = self.infer(&wave, &scratch.file("transcript")).await?;
        Ok(Transcript { text, duration_ms })
    }

    async fn convert(&self, input: &Path, wave: &Path, format: Format) -> Result<()> {
        let mut command = process::command(&self.ffmpeg, wave);
        command.args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            "1",
            "-max_alloc",
            "33554432",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            DEMUXERS,
        ]);
        if let Some(demuxer) = format.demuxer() {
            command.args(["-f", demuxer]);
        }
        command
            .arg("-i")
            .arg(input)
            .args([
                "-map",
                "0:a:0",
                "-t",
                "181",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(wave);
        process::run(command, "Could not decode recording").await
    }

    async fn infer(&self, wave: &Path, output: &Path) -> Result<String> {
        let mut command = process::command(&self.whisper, output);
        command
            .args([
                "-ng",
                "-t",
                &self.threads.to_string(),
                "-l",
                "en",
                "-tp",
                "0",
                "-nf",
                "-mc",
                "0",
                "-nt",
                "-np",
                "-otxt",
                "-of",
            ])
            .arg(output)
            .arg("-m")
            .arg(&self.model)
            .arg("-f")
            .arg(wave);
        process::run(command, "Whisper transcription failed").await?;
        let text = String::from_utf8(process::read(&output.with_extension("txt"), 16 * 1024)?)?;
        Ok(clean(&text))
    }
}

fn clean(text: &str) -> String {
    static NOISE: OnceLock<Regex> = OnceLock::new();
    let noise =
        NOISE.get_or_init(|| Regex::new(r"\[[^\]]*\]|\([^)]*\)|\*[^*]*\*").expect("noise labels"));
    noise
        .replace_all(text, " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    #[test]
    fn silence_and_stage_directions_do_not_become_room_messages() {
        assert_eq!(super::clean("[BLANK_AUDIO]"), "");
        assert_eq!(
            super::clean(" Hi (music) there *laughs* [noise]. "),
            "Hi there ."
        );
    }
}
