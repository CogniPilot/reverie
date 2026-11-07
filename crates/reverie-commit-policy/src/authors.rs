//! The private author list for `no_ai_coauthors`: which trailer keys are checked and which author
//! patterns they refuse. It is never part of this repository. The caller names it and pins its
//! SHA-256, and anything missing, altered or malformed is refused. Entries are only compared:
//! `Debug` and errors show the digest and counts, never an entry.

use crate::Error;
use crate::message::trailer_key;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::Path;

/// The only schema this version reads.
pub const AUTHOR_LIST_SCHEMA: u64 = 1;

/// A loaded, pinned author list.
pub struct AuthorList {
    trailers: Vec<String>,
    patterns: Vec<String>,
    digest: String,
}

impl fmt::Debug for AuthorList {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AuthorList")
            .field("digest", &self.digest)
            .field("trailers", &self.trailers.len())
            .field("patterns", &self.patterns.len())
            .finish()
    }
}

fn malformed(why: &str) -> Error {
    Error::Malformed(format!("author list {why}"))
}

/// A non-empty list of non-empty strings from `field`.
fn strings(file: &Map<String, Value>, field: &str) -> Result<Vec<String>, Error> {
    let items = match file.get(field) {
        Some(Value::Array(items)) if !items.is_empty() => items,
        _ => return Err(malformed(&format!("{field} must be a non-empty list"))),
    };
    items
        .iter()
        .enumerate()
        .map(|(index, item)| match item {
            Value::String(text) if !text.is_empty() => Ok(text.clone()),
            _ => Err(malformed(&format!("{field} entry {index} is invalid"))),
        })
        .collect()
}

impl AuthorList {
    /// Reads, pins and validates a list file.
    ///
    /// # Errors
    /// [`Error::Malformed`] for an unreadable, mismatched or malformed file; there are no defaults.
    pub fn load(path: &Path, pinned_sha256: &str) -> Result<Self, Error> {
        let bytes = std::fs::read(path)
            .map_err(|error| malformed(&format!("is unreadable: {}", error.kind())))?;
        Self::from_bytes(&bytes, pinned_sha256)
    }

    /// Validates list bytes against a pinned digest, checked before anything is parsed.
    ///
    /// # Errors
    /// See [`AuthorList::load`].
    pub fn from_bytes(bytes: &[u8], pinned_sha256: &str) -> Result<Self, Error> {
        let well_formed = pinned_sha256.len() == 64
            && pinned_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !well_formed {
            return Err(malformed("pin must be 64 lowercase hex characters"));
        }
        let digest: String = Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if digest != pinned_sha256 {
            return Err(malformed("SHA-256 does not match the pinned digest"));
        }
        let Ok(Value::Object(file)) = serde_json::from_slice::<Value>(bytes) else {
            return Err(malformed("is not a JSON object"));
        };
        if file
            .keys()
            .any(|key| !["schema", "trailers", "patterns"].contains(&key.as_str()))
        {
            return Err(malformed("has unsupported fields"));
        }
        if file.get("schema").and_then(Value::as_u64) != Some(AUTHOR_LIST_SCHEMA) {
            return Err(malformed(&format!("schema must be {AUTHOR_LIST_SCHEMA}")));
        }
        let trailers = strings(&file, "trailers")?;
        if let Some(index) = trailers.iter().position(|key| !trailer_key(key)) {
            return Err(malformed(&format!("trailers entry {index} is invalid")));
        }
        Ok(Self {
            trailers,
            patterns: strings(&file, "patterns")?,
            digest,
        })
    }

    /// The SHA-256 of the file that was loaded.
    #[must_use]
    pub fn digest(&self) -> &str {
        &self.digest
    }

    /// Supplies the policy's `commits.ai_author_trailers` and `commits.ai_author_patterns` where
    /// the policy does not set them itself; the owner's policy keeps precedence.
    ///
    /// # Errors
    /// [`Error::Malformed`] when the policy's `commits` is not an object.
    pub fn apply(&self, policy: &mut Map<String, Value>) -> Result<(), Error> {
        let commits = policy
            .entry("commits")
            .or_insert_with(|| Value::Object(Map::new()));
        let Value::Object(commits) = commits else {
            return Err(Error::Malformed("commits must be an object".into()));
        };
        commits
            .entry("ai_author_trailers")
            .or_insert_with(|| Value::from(self.trailers.clone()));
        commits
            .entry("ai_author_patterns")
            .or_insert_with(|| Value::from(self.patterns.clone()));
        Ok(())
    }
}
