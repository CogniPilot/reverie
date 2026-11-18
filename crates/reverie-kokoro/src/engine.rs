//! Adapt the pinned Kokoro graph and style vectors to the speech API.
use crate::{
    Result, assets, audio,
    phonemes::{self, Espeak},
    voices::{DIMENSION, Voice, VoiceBank},
};
use ort::{session::Session, value::Tensor};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub(super) struct Engine {
    session: Session,
    voices: VoiceBank,
    phonemizer: Espeak,
    vocab: BTreeMap<char, i64>,
}

impl Engine {
    pub(super) fn load(directory: &Path) -> Result<Self> {
        assets::ensure(directory)?;
        let library = option_env!("REVERIE_KOKORO_ONNX")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var_os("ORT_DYLIB_PATH")
                    .map_or_else(|| PathBuf::from("libonnxruntime.so"), PathBuf::from)
            });
        ort::init_from(library)?.with_telemetry(false).commit();
        let session = Session::builder()?
            .with_intra_threads(2)
            .map_err(ort::Error::<()>::from)?
            .with_inter_threads(1)
            .map_err(ort::Error::<()>::from)?
            .commit_from_file(directory.join(assets::MODEL))?;
        let phonemizer = Espeak::new();
        let voices = VoiceBank::load(&directory.join(assets::VOICES), &phonemizer.languages()?)?;
        let vocab = serde_json::from_str(include_str!("vocab.json"))?;
        Ok(Self {
            session,
            voices,
            phonemizer,
            vocab,
        })
    }

    pub(super) fn voices(&self) -> Vec<Voice> {
        self.voices.options()
    }

    pub(super) fn synthesize(&mut self, text: &str, voice: &Voice) -> Result<Option<Vec<u8>>> {
        let speech = self.phonemizer.text(voice.language, text)?;
        let retained: String = speech
            .chars()
            .filter(|glyph| self.vocab.contains_key(glyph))
            .collect();
        let normalized = retained.split_whitespace().collect::<Vec<_>>().join(" ");
        let chunks = phonemes::chunks(&normalized);
        if chunks.is_empty() {
            return Ok(None);
        }
        let mut samples = Vec::new();
        for (index, chunk) in chunks.iter().enumerate() {
            let tokens: Vec<i64> = chunk
                .chars()
                .filter_map(|glyph| self.vocab.get(&glyph).copied())
                .collect();
            let style = self.voices.style(voice, tokens.len());
            let audio = infer(&mut self.session, &tokens, style)?;
            let padding = if index + 1 < chunks.len() {
                phonemes::pause(chunk)
            } else {
                0
            };
            if samples.len() + audio.len() + padding > audio::MAX_SAMPLES {
                return Err("Kokoro output exceeds its bound".into());
            }
            samples.extend(audio);
            samples.resize(samples.len() + padding, 0.0);
        }
        Ok(Some(audio::wave(&samples)?))
    }
}

fn infer(session: &mut Session, tokens: &[i64], style: &[f32]) -> Result<Vec<f32>> {
    let mut padded = Vec::with_capacity(tokens.len() + 2);
    padded.push(0);
    padded.extend_from_slice(tokens);
    padded.push(0);
    let output = session.run(ort::inputs![
        "tokens" => Tensor::from_array(([1, padded.len()], padded))?,
        "style" => Tensor::from_array(([1, DIMENSION], style.to_vec()))?,
        "speed" => Tensor::from_array(([1], vec![1.0_f32]))?
    ])?;
    let (_, samples) = output
        .get("audio")
        .ok_or("Kokoro graph has no audio output")?
        .try_extract_tensor::<f32>()?;
    if samples.len() > audio::MAX_SAMPLES || samples.iter().any(|sample| !sample.is_finite()) {
        return Err("Invalid Kokoro audio samples".into());
    }
    Ok(audio::trim(samples).to_vec())
}
