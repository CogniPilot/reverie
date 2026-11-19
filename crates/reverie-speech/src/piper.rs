use crate::{
    Result,
    process::{self, Scratch},
};
use serde::Serialize;
use serde_json::Value;
use std::{fs, path::PathBuf, time::Duration};
use tokio::{sync::Mutex, time};

pub(super) const AUDIO_LIMIT: usize = 8 * 1024 * 1024;

pub(super) struct Piper {
    program: PathBuf,
    directory: PathBuf,
    default: String,
    scratch: PathBuf,
    serial: Mutex<()>,
}

#[derive(Serialize)]
pub(super) struct Voice {
    name: String,
    default: bool,
    language: String,
    quality: String,
    sample_rate: Option<u64>,
}

impl Piper {
    pub(super) fn new(
        program: PathBuf,
        directory: PathBuf,
        default: String,
        scratch: PathBuf,
    ) -> Result<Self> {
        if !valid_name(&default) {
            return Err("Invalid default Piper voice".into());
        }
        Ok(Self {
            program: process::executable(program),
            directory: std::path::absolute(directory)?,
            default,
            scratch: std::path::absolute(scratch)?,
            serial: Mutex::new(()),
        })
    }

    pub(super) fn default(&self) -> &str {
        &self.default
    }

    pub(super) fn ready(&self) -> bool {
        self.program.is_file() && self.paths(&self.default).is_some()
    }

    fn paths(&self, name: &str) -> Option<(PathBuf, PathBuf)> {
        if !valid_name(name) {
            return None;
        }
        let model = self.directory.join(format!("{name}.onnx"));
        let config = self.directory.join(format!("{name}.onnx.json"));
        (process::asset(&model, 1024 * 1024 * 1024) && process::asset(&config, 1024 * 1024))
            .then_some((model, config))
    }

    pub(super) fn voices(&self) -> Vec<Voice> {
        let Ok(entries) = fs::read_dir(&self.directory) else {
            return vec![];
        };
        let mut voices: Vec<_> = entries
            .take(2048)
            .filter_map(|item| {
                let file = item.ok()?.file_name();
                self.voice(file.to_str()?.strip_suffix(".onnx")?)
            })
            .collect();
        voices.sort_by(|a, b| (!a.default, &a.name).cmp(&(!b.default, &b.name)));
        voices.truncate(512);
        voices
    }

    fn voice(&self, name: &str) -> Option<Voice> {
        let (_, config) = self.paths(name)?;
        let raw = process::read(&config, 1024 * 1024).ok()?;
        let values: Value = serde_json::from_slice(&raw).ok()?;
        Some(Voice {
            name: name.to_owned(),
            default: name == self.default,
            language: values["language"]["code"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(80)
                .collect(),
            quality: values["audio"]["quality"]
                .as_str()
                .unwrap_or_else(|| name.rsplit('-').next().unwrap_or(""))
                .chars()
                .take(80)
                .collect(),
            sample_rate: values["audio"]["sample_rate"].as_u64(),
        })
    }

    pub(super) fn installed(&self, voice: Option<&str>) -> bool {
        self.paths(voice.unwrap_or(&self.default)).is_some()
    }

    pub(super) async fn synthesize(&self, text: &str, voice: Option<&str>) -> Result<Vec<u8>> {
        time::timeout(Duration::from_secs(25), self.render(text, voice)).await?
    }

    async fn render(&self, text: &str, voice: Option<&str>) -> Result<Vec<u8>> {
        let _serial = self.serial.lock().await;
        let (model, config) = self
            .paths(voice.unwrap_or(&self.default))
            .ok_or("Voice is not installed")?;
        let scratch = Scratch::create(&self.scratch)?;
        let audio = scratch.file("reply.wav");
        let mut command = process::command(&self.program, &audio);
        command
            .arg("--model")
            .arg(model)
            .arg("--config")
            .arg(config)
            .arg("--output_file")
            .arg(&audio);
        process::stdin(
            &mut command,
            &scratch.file("text"),
            format!("{text}\n").as_bytes(),
        )?;
        process::run(command, "Piper synthesis failed").await?;
        let wav = process::read(&audio, AUDIO_LIMIT)?;
        if wav.len() < 44 || wav.get(..4) != Some(b"RIFF") || wav.get(8..12) != Some(b"WAVE") {
            return Err("Piper produced an invalid recording".into());
        }
        Ok(wav)
    }
}

fn valid_name(name: &str) -> bool {
    (1..=128).contains(&name.len())
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
