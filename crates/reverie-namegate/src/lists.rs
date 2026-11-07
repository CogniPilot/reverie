//! The private list file. It is never part of this repository: the caller names it and pins its
//! SHA-256, and anything missing, altered or empty is refused rather than treated as "no names".

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::Path;

/// The only schema this version reads.
pub const SCHEMA: u32 = 1;

/// The list categories, in report order.
pub const CATEGORIES: [&str; 6] = [
    "team",
    "internal",
    "ai_words",
    "ai_phrases",
    "path_markers",
    "allow",
];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListFile {
    schema: u32,
    home_repo: String,
    team: Vec<String>,
    internal: Vec<String>,
    ai_words: Vec<String>,
    ai_phrases: Vec<String>,
    path_markers: Vec<String>,
    allow: Vec<String>,
}

/// Validated lists. Entries are only ever compared, never printed.
#[derive(Debug)]
pub struct Lists {
    pub(crate) home_repo: String,
    pub(crate) team: Vec<String>,
    pub(crate) internal: Vec<String>,
    pub(crate) ai_words: Vec<String>,
    pub(crate) ai_phrases: Vec<String>,
    pub(crate) path_markers: Vec<Vec<MarkerPart>>,
    pub(crate) allow: Vec<String>,
    digest: String,
}

/// One unit of a path marker: a literal character or `{digit}`, any Unicode decimal digit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MarkerPart {
    Char(char),
    Digit,
}

/// Why a list file was refused. Messages name the category, never an entry.
#[derive(Debug, PartialEq, Eq)]
pub enum ListError {
    Unreadable(String),
    DigestMismatch,
    BadDigestArgument,
    Malformed(String),
    Schema(u32),
    EmptyCategory(&'static str),
    BadEntry(&'static str, usize),
}

impl fmt::Display for ListError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreadable(why) => write!(f, "list file unreadable: {why}"),
            Self::DigestMismatch => write!(f, "list file SHA-256 does not match the pinned digest"),
            Self::BadDigestArgument => {
                write!(f, "pinned digest must be 64 lowercase hex characters")
            }
            Self::Malformed(why) => write!(f, "list file is not valid schema JSON: {why}"),
            Self::Schema(found) => write!(
                f,
                "list file schema {found} is not supported (expected {SCHEMA})"
            ),
            Self::EmptyCategory(category) => write!(f, "list category {category} is empty"),
            Self::BadEntry(category, index) => {
                write!(f, "list category {category} entry {index} is invalid")
            }
        }
    }
}

impl std::error::Error for ListError {}

impl Lists {
    /// Reads, pins and validates a list file.
    ///
    /// # Errors
    /// Any unreadable, mismatched, malformed or empty input is an error; there are no defaults.
    pub fn load(path: &Path, pinned_sha256: &str) -> Result<Self, ListError> {
        let bytes =
            std::fs::read(path).map_err(|error| ListError::Unreadable(error.kind().to_string()))?;
        Self::from_bytes(&bytes, pinned_sha256)
    }

    /// Validates list bytes against a pinned digest.
    ///
    /// # Errors
    /// See [`Lists::load`].
    pub fn from_bytes(bytes: &[u8], pinned_sha256: &str) -> Result<Self, ListError> {
        if pinned_sha256.len() != 64
            || !pinned_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(ListError::BadDigestArgument);
        }
        let digest = hex(&Sha256::digest(bytes));
        if digest != pinned_sha256 {
            return Err(ListError::DigestMismatch);
        }
        let file: ListFile = serde_json::from_slice(bytes)
            .map_err(|error| ListError::Malformed(error.classify_name()))?;
        if file.schema != SCHEMA {
            return Err(ListError::Schema(file.schema));
        }
        Self::validate(file, digest)
    }

    fn validate(file: ListFile, digest: String) -> Result<Self, ListError> {
        let words =
            |category: &'static str, entries: Vec<String>| -> Result<Vec<String>, ListError> {
                nonempty(category, &entries)?;
                match entries.iter().position(|entry| !is_word_entry(entry)) {
                    Some(index) => Err(ListError::BadEntry(category, index)),
                    None => Ok(entries),
                }
            };
        let literals =
            |category: &'static str, entries: Vec<String>| -> Result<Vec<String>, ListError> {
                nonempty(category, &entries)?;
                match entries.iter().position(String::is_empty) {
                    Some(index) => Err(ListError::BadEntry(category, index)),
                    None => Ok(entries),
                }
            };
        if file.home_repo.is_empty() {
            return Err(ListError::EmptyCategory("home_repo"));
        }
        let markers = literals("path_markers", file.path_markers)?;
        let path_markers = markers
            .iter()
            .enumerate()
            .map(|(index, marker)| {
                parse_marker(marker).ok_or(ListError::BadEntry("path_markers", index))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            home_repo: file.home_repo,
            team: words("team", file.team)?,
            internal: words("internal", file.internal)?,
            ai_words: words("ai_words", file.ai_words)?,
            ai_phrases: literals("ai_phrases", file.ai_phrases)?,
            path_markers,
            allow: literals("allow", file.allow)?,
            digest,
        })
    }

    /// The SHA-256 of the file that was loaded.
    #[must_use]
    pub fn digest(&self) -> &str {
        &self.digest
    }

    /// Entry counts per category, in [`CATEGORIES`] order. Counts reveal nothing about entries.
    #[must_use]
    pub fn counts(&self) -> [usize; 6] {
        [
            self.team.len(),
            self.internal.len(),
            self.ai_words.len(),
            self.ai_phrases.len(),
            self.path_markers.len(),
            self.allow.len(),
        ]
    }
}

/// Token entries are compared against lowercased letter runs, so they must be lowercase letters.
fn is_word_entry(entry: &str) -> bool {
    !entry.is_empty() && entry.to_lowercase() == entry && entry.chars().all(char::is_alphabetic)
}

fn nonempty(category: &'static str, entries: &[String]) -> Result<(), ListError> {
    if entries.is_empty() {
        Err(ListError::EmptyCategory(category))
    } else {
        Ok(())
    }
}

/// `{digit}` stands for one Unicode decimal digit; every other character is literal.
fn parse_marker(marker: &str) -> Option<Vec<MarkerPart>> {
    let mut parts = Vec::new();
    let mut rest = marker;
    while let Some(ch) = rest.chars().next() {
        if let Some(after) = rest.strip_prefix("{digit}") {
            parts.push(MarkerPart::Digit);
            rest = after;
        } else if ch == '{' || ch == '}' {
            return None;
        } else {
            parts.push(MarkerPart::Char(ch));
            rest = &rest[ch.len_utf8()..];
        }
    }
    Some(parts)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

trait ClassifyName {
    fn classify_name(&self) -> String;
}

impl ClassifyName for serde_json::Error {
    /// Category and position only: a parse message could otherwise quote list text.
    fn classify_name(&self) -> String {
        format!(
            "{:?} error at line {} column {}",
            self.classify(),
            self.line(),
            self.column()
        )
    }
}
