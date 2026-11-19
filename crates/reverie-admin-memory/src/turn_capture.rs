//! Capture the exact waking request before the compatibility caller can run
//! any room operations. Historical message text carries no turn authority.

use crate::refused;
use reverie_contracts::memory::channel::journal::JournalSnapshot;
use reverie_core::PythonTextRef;
use reverie_python_regex::CompiledPattern;
use serde::Serialize;
use serde_json::value::RawValue;
use std::{io, sync::LazyLock};

const QUERY_CHARS: usize = 300;

static READ_ONLY: LazyLock<CompiledPattern> = LazyLock::new(|| {
    compile(concat!(
        r"\bread[\s\-\u2010-\u2015]+only\b|",
        r"\b(?:do\s+not|don't|don\u2019t|never)\s+(?:write|commit)\b|",
        r"\b(?:do\s+not|don't|don\u2019t|never)\s+(?:create|save)\s+(?:a\s+)?journal\b",
    ))
});

static ASKED_TO_REMEMBER: LazyLock<CompiledPattern> = LazyLock::new(|| {
    compile(concat!(
        r"\bremember\s+(?:this|that|it|to)\b|",
        r"\b(?:save|note|journal|log)\s+(?:this|that|it)\b|",
        r"\bwrite\s+(?:this|that|it)\s+down\b|",
        r"\b(?:don't|don\u2019t|do\s+not)\s+forget\b|",
        r"\bkeep\s+(?:this|that|it)\s+in\s+mind\b|",
        r"\b(?:add|put)\s+(?:this|that|it)\s+(?:to|in)\s+(?:your\s+)?journal\b",
    ))
});

fn compile(pattern: &str) -> CompiledPattern {
    CompiledPattern::compile(PythonTextRef::from_scalar_text(pattern))
        .expect("checked Hands intent pattern")
}

fn read_only(text: &str) -> bool {
    READ_ONLY.is_match(PythonTextRef::from_scalar_text(text))
}

fn asked_to_remember(text: &str) -> bool {
    ASKED_TO_REMEMBER.is_match(PythonTextRef::from_scalar_text(text))
}

#[derive(Serialize)]
pub(crate) struct Capture {
    pub(super) captured: Box<RawValue>,
    pub(super) catalog: String,
    pub(super) query: String,
    pub(super) read_only: bool,
    pub(super) asked_to_remember: bool,
}

pub(crate) fn execute(input: &[u8]) -> io::Result<Capture> {
    let snapshot = JournalSnapshot::decode(input).ok_or_else(refused)?;
    let request = snapshot.request_text();
    Ok(Capture {
        captured: snapshot.captured().ok_or_else(refused)?,
        catalog: snapshot.catalog().ok_or_else(refused)?,
        query: request.chars().take(QUERY_CHARS).collect(),
        read_only: read_only(request),
        asked_to_remember: asked_to_remember(request),
    })
}

#[cfg(test)]
mod tests;
