//! Translate text with the container's eSpeak NG and keep model punctuation.
use crate::Result;
use std::{
    collections::BTreeSet,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const MARKS: &str = ";:,.!?¡¿—…\"«»“”(){}[]";
const SENTENCE: &str = ".!?…";
const CLAUSE: &str = ",;:";
const MAX: usize = 510;

pub(super) struct Espeak {
    catalog: PathBuf,
    phonemes: PathBuf,
}

impl Espeak {
    pub(super) fn new() -> Self {
        Self {
            catalog: option_env!("REVERIE_KOKORO_ESPEAK")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::var_os("REVERIE_KOKORO_ESPEAK")
                        .map_or_else(|| PathBuf::from("espeak-ng"), PathBuf::from)
                }),
            phonemes: option_env!("REVERIE_KOKORO_PHONEMES")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::var_os("REVERIE_KOKORO_PHONEMES")
                        .map_or_else(|| PathBuf::from("reverie-kokoro-phonemes"), PathBuf::from)
                }),
        }
    }

    pub(super) fn languages(&self) -> Result<BTreeSet<String>> {
        let output = Command::new(&self.catalog).arg("--voices").output()?;
        if !output.status.success() {
            return Err("eSpeak NG voice discovery failed".into());
        }
        Ok(String::from_utf8(output.stdout)?
            .lines()
            .skip(1)
            .filter_map(|line| line.split_whitespace().nth(1).map(str::to_owned))
            .collect())
    }

    pub(super) fn text(&self, language: &str, text: &str) -> Result<String> {
        let mut phonemes = String::new();
        for word in segments(text) {
            if word.trim().is_empty() || word.trim().starts_with(|c| MARKS.contains(c)) {
                phonemes.push_str(word);
                continue;
            }
            phonemes.push_str(&speak(&self.phonemes, language, word.trim())?);
        }
        Ok(phonemes)
    }
}

fn decimal(text: &str, offset: usize, c: char) -> bool {
    (c == '.' || c == ',')
        && text
            .as_bytes()
            .get(offset.wrapping_sub(1))
            .is_some_and(u8::is_ascii_digit)
        && text
            .as_bytes()
            .get(offset + 1)
            .is_some_and(u8::is_ascii_digit)
}

fn segments(text: &str) -> Vec<&str> {
    let mut last = 0;
    let mut segments = Vec::new();
    for (at, c) in text.char_indices() {
        if !MARKS.contains(c) || decimal(text, at, c) {
            continue;
        }
        let before = text[last..at].trim_end().len() + last;
        if before > last {
            segments.push(&text[last..before]);
        }
        let after = at + c.len_utf8();
        last = text.len() - text[after..].trim_start().len();
        segments.push(&text[before..last]);
    }
    if last < text.len() {
        segments.push(&text[last..]);
    }
    segments
}

fn speak(program: &Path, language: &str, text: &str) -> Result<String> {
    let mut child = Command::new(program)
        .arg(language)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let sent = child
        .stdin
        .take()
        .ok_or("Missing eSpeak NG input")?
        .write_all(text.as_bytes());
    let output = child.wait_with_output()?;
    sent?;
    if !output.status.success() || output.stdout.len() > 32768 {
        return Err("eSpeak NG phonemization failed".into());
    }
    Ok(String::from_utf8(output.stdout)?
        .replace('_', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" "))
}

pub(super) fn chunks(text: &str) -> Vec<String> {
    let mut atoms = Vec::new();
    collect(text, 0, &mut atoms);
    let fewest = pack(&atoms, MAX).len();
    let mut low = atoms.iter().map(|s| s.chars().count()).max().unwrap_or(0);
    let mut high = MAX;
    while low < high {
        let middle = (low + high) / 2;
        if pack(&atoms, middle).len() > fewest {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    pack(&atoms, low)
}

fn collect(text: &str, level: usize, atoms: &mut Vec<String>) {
    if text.is_empty() {
        return;
    }
    if text.chars().count() <= MAX {
        atoms.push(text.into());
        return;
    }
    if let Some(pieces) = boundaries(text, level) {
        for piece in pieces {
            collect(piece, level + 1, atoms);
        }
        return;
    }
    let chars: Vec<char> = text.chars().collect();
    atoms.extend(chars.chunks(MAX).map(|part| part.iter().collect()));
}

fn boundaries(text: &str, level: usize) -> Option<Vec<&str>> {
    let marks = match level {
        0 => SENTENCE,
        1 => CLAUSE,
        2 => {
            return Some(text.split_whitespace().collect())
                .filter(|words: &Vec<_>| words.len() > 1);
        }
        _ => return None,
    };
    let mut start = 0;
    let mut parts = Vec::new();
    for (at, c) in text.char_indices() {
        if c == ' ' && text[..at].ends_with(|c| marks.contains(c)) {
            parts.push(&text[start..at]);
            start = at + 1;
        }
    }
    if parts.is_empty() {
        return boundaries(text, level + 1);
    }
    parts.push(&text[start..]);
    Some(parts)
}

fn pack(atoms: &[String], limit: usize) -> Vec<String> {
    let mut packed = Vec::new();
    let mut current = String::new();
    let mut length = 0;
    for atom in atoms {
        let size = atom.chars().count();
        if length > 0 && length + 1 + size > limit {
            packed.push(std::mem::take(&mut current));
            length = 0;
        }
        if length > 0 {
            current.push(' ');
            length += 1;
        }
        current.push_str(atom);
        length += size;
    }
    if !current.is_empty() {
        packed.push(current);
    }
    packed
}

pub(super) fn pause(text: &str) -> usize {
    let rate = crate::audio::RATE as usize;
    match text.chars().last() {
        Some(c) if SENTENCE.contains(c) => rate / 4,
        Some(c) if CLAUSE.contains(c) => rate / 10,
        _ => 0,
    }
}
