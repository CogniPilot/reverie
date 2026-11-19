mod file;
mod reader;
#[cfg(test)]
mod tests;

use super::delta::{Display, DisplayKind};
use file::{TRACE_BYTES, TraceFile};
pub(crate) use reader::Reader as TraceReader;
pub(crate) use reader::trace_worker;
use regex_lite::Regex;
use reverie_host::embeddings::model_api::Failure;
use std::{path::Path, sync::LazyLock};

const REDACTED: &str = "[redacted]";
// Preserve the old trace format's Unicode whitespace and case-insensitive
// ASCII credential labels, including the extra characters Python folds.
const SPACE: &str = "\u{9}-\u{d}\u{1c}-\u{20}\u{85}\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}";
const LABEL: &str = "(?:ap[iİı][_-]?[kK]ey|pa[sſ][sſ]word|author[iİı]zat[iİı]on)";
const AUTH_SCHEME: &str = "(?:bearer|ba[sſ][iİı]c)";
static CREDENTIAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?i)(?:bearer[{SPACE}]+|{LABEL}["']?[{SPACE}]*[=:][{SPACE}]*["']?[{SPACE}]*(?:{AUTH_SCHEME}[{SPACE}]+)?)[^{SPACE}"',;}}]+"#
    ))
    .expect("valid credential pattern")
});
static OPEN_LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?i)(?:bearer[{SPACE}]*|{LABEL}["']?[{SPACE}]*(?:[=:][{SPACE}]*["']?[{SPACE}]*{AUTH_SCHEME}?[{SPACE}]*)?)\z"#
    ))
    .expect("valid unfinished credential label pattern")
});

#[derive(Default)]
pub(super) struct Trace {
    writer: Option<Writer>,
}

impl Trace {
    pub(super) fn new(path: Option<&Path>, secret: Option<&str>) -> Result<Self, Failure> {
        let writer = path
            .map(|path| Writer::new(path, secret, TRACE_BYTES))
            .transpose()?;
        Ok(Self { writer })
    }

    pub(super) fn flush(&mut self) -> Result<(), Failure> {
        self.writer.as_mut().map_or(Ok(()), Writer::flush)
    }
}

impl Display for Trace {
    fn write(&mut self, kind: DisplayKind, value: &str) -> Result<(), Failure> {
        self.writer
            .as_mut()
            .map_or(Ok(()), |writer| writer.write(kind, value))
    }
}

struct Writer {
    file: TraceFile,
    secret: Option<String>,
    keep: usize,
    thinking: String,
    answer: String,
}

impl Writer {
    fn new(path: &Path, secret: Option<&str>, limit: usize) -> Result<Self, Failure> {
        let chars = secret.map_or(0, |secret| secret.chars().count());
        if chars > 4096 {
            return Err(Failure::Invalid);
        }
        Ok(Self {
            file: TraceFile::new(path, limit).map_err(|_| Failure::Invalid)?,
            secret: secret
                .filter(|secret| !secret.is_empty())
                .map(str::to_owned),
            // A credential label and a selected key may span provider deltas.
            keep: chars.saturating_sub(1).max("authorization".len() - 1),
            thinking: String::new(),
            answer: String::new(),
        })
    }

    fn write(&mut self, kind: DisplayKind, value: &str) -> Result<(), Failure> {
        let pending = match kind {
            DisplayKind::Thinking => &mut self.thinking,
            DisplayKind::Answer => &mut self.answer,
        };
        pending.push_str(value);
        if let Some(secret) = &self.secret {
            *pending = pending.replace(secret, REDACTED);
        }
        let mut ready = pending
            .char_indices()
            .rev()
            .nth(self.keep - 1)
            .map_or(0, |(start, _)| start);
        for matched in CREDENTIAL.find_iter(pending) {
            if matched.start() < ready && (ready < matched.end() || matched.end() == pending.len())
            {
                ready = matched.start();
            }
        }
        if let Some(matched) = OPEN_LABEL.find(pending) {
            ready = ready.min(matched.start());
        }
        let suffix = pending.split_off(ready);
        let ready = std::mem::replace(pending, suffix);
        self.append(kind, &ready)
    }

    fn flush(&mut self) -> Result<(), Failure> {
        let thinking = std::mem::take(&mut self.thinking);
        let answer = std::mem::take(&mut self.answer);
        self.append(DisplayKind::Thinking, &thinking)?;
        self.append(DisplayKind::Answer, &answer)
    }

    fn append(&self, kind: DisplayKind, value: &str) -> Result<(), Failure> {
        self.file
            .append(kind.name(), &redact(value))
            .map_err(|_| Failure::Invalid)
    }
}

pub(crate) fn redact(value: &str) -> String {
    CREDENTIAL
        .replace_all(value, REDACTED)
        .chars()
        .filter(|ch| {
            !matches!(*ch, '\u{0}'..='\u{8}' | '\u{b}'..='\u{1f}' | '\u{7f}'..='\u{9f}'
            | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .collect()
}
