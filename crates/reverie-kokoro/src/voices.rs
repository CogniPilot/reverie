//! Read Kokoro's existing NPZ voice archive without converting the cache.
use crate::Result;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    path::Path,
};
use zip::ZipArchive;

pub(super) const DIMENSION: usize = 256;
const ROWS: usize = 510;
const MAX_MEMBER: u64 = (ROWS * DIMENSION * 4 + 4096) as u64;

#[derive(Clone, serde::Serialize)]
pub(super) struct Voice {
    pub(super) id: String,
    label: String,
    pub(super) language: &'static str,
    gender: &'static str,
}

pub(super) struct VoiceBank(BTreeMap<String, (Voice, Vec<f32>)>);

impl VoiceBank {
    pub(super) fn load(path: &Path, supported: &BTreeSet<String>) -> Result<Self> {
        let mut archive = ZipArchive::new(File::open(path)?)?;
        if archive.len() > 64 {
            return Err("Kokoro voice archive has too many entries".into());
        }
        let mut voices = BTreeMap::new();
        for index in 0..archive.len() {
            let entry = archive.by_index(index)?;
            let id = entry
                .name()
                .strip_suffix(".npy")
                .ok_or("Expected NPY voice")?;
            let voice = describe(id)?;
            if !supported.contains(voice.language) {
                continue;
            }
            let id = id.to_owned();
            let samples = styles(entry)?;
            if voices.insert(id, (voice, samples)).is_some() {
                return Err("Duplicate Kokoro voice".into());
            }
        }
        if voices.is_empty() {
            return Err("No compatible Kokoro voices are installed".into());
        }
        Ok(Self(voices))
    }

    pub(super) fn options(&self) -> Vec<Voice> {
        self.0.values().map(|(voice, _)| voice.clone()).collect()
    }

    pub(super) fn style(&self, voice: &Voice, length: usize) -> &[f32] {
        let start = (length.min(ROWS) - 1) * DIMENSION;
        &self.0[&voice.id].1[start..start + DIMENSION]
    }
}

fn styles(entry: zip::read::ZipFile<'_>) -> Result<Vec<f32>> {
    if entry.size() > MAX_MEMBER {
        return Err("Kokoro voice exceeds its bound".into());
    }
    let file = npyz::NpyFile::new(entry.take(MAX_MEMBER))?;
    if file.shape() != [ROWS as u64, 1, DIMENSION as u64] || file.order() != npyz::Order::C {
        return Err("Unexpected Kokoro voice tensor shape".into());
    }
    Ok(file.into_vec()?)
}

fn describe(id: &str) -> Result<Voice> {
    let (prefix, name) = id.split_once('_').ok_or("Invalid Kokoro voice ID")?;
    if prefix.len() != 2
        || name.is_empty()
        || !id.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
    {
        return Err("Invalid Kokoro voice ID".into());
    }
    let [language, gender] = [prefix.as_bytes()[0], prefix.as_bytes()[1]];
    let language = match language {
        b'a' => "en-us",
        b'b' => "en-gb",
        b'e' => "es",
        b'f' => "fr-fr",
        b'h' => "hi",
        b'i' => "it",
        b'p' => "pt-br",
        b'j' => "ja",
        b'z' => "cmn",
        _ => return Err("Unknown Kokoro language".into()),
    };
    let gender = match gender {
        b'f' => "feminine",
        b'm' => "masculine",
        _ => "unspecified",
    };
    let label = name
        .split('_')
        .map(|word| {
            let mut word = word.to_string();
            if let Some(first) = word.get_mut(..1) {
                first.make_ascii_uppercase();
            }
            word
        })
        .collect::<Vec<_>>()
        .join(" ");
    Ok(Voice {
        id: id.into(),
        label,
        language,
        gender,
    })
}
