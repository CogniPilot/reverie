//! Python pathlib's pure POSIX lexical comparisons, independent of the host OS.
//! These values are data, never canonical filesystem or mount custody proof.
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PosixPathError;
impl fmt::Display for PosixPathError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str("POSIX_PATH_CODEPOINT")
    }
}
impl std::error::Error for PosixPathError {}

/// Lexical Python path data. Preserve exactly two leading slashes, '..', NUL,
/// control characters and lone surrogates; fold empty and '.' components only.
/// Individual consuming policies must impose their own path restrictions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PosixPath {
    anchor: u8,
    parts: Vec<Vec<u32>>,
}
impl PosixPath {
    pub fn try_new(value: &[u32]) -> Result<Self, PosixPathError> {
        if value.iter().any(|&point| point > 0x10ffff) {
            return Err(PosixPathError);
        }
        let leading = value.iter().take_while(|&&point| point == 47).count();
        let anchor = match leading {
            0 => 0,
            2 => 2,
            _ => 1,
        };
        let parts = value
            .split(|&point| point == 47)
            .filter(|part| !part.is_empty() && *part != [46])
            .map(<[u32]>::to_vec)
            .collect();
        Ok(Self { anchor, parts })
    }
    pub fn from_scalar_text(value: &str) -> Self {
        Self::try_new(&value.chars().map(u32::from).collect::<Vec<_>>())
            .expect("scalar text consists of Python codepoints")
    }
    pub fn is_absolute(&self) -> bool {
        self.anchor != 0
    }
    pub fn has_parent_component(&self) -> bool {
        self.parts.iter().any(|part| part == &[46, 46])
    }
    /// Normalized non-anchor components, retaining literal '..' and Python
    /// codepoints. This lexical view makes no filesystem/custody assertion.
    pub fn components(&self) -> impl ExactSizeIterator<Item = &[u32]> + DoubleEndedIterator {
        self.parts.iter().map(Vec::as_slice)
    }
    pub fn is_single_rooted(&self) -> bool {
        self.anchor == 1
    }
    pub fn relative_to(&self, root: &Self) -> Option<Self> {
        self.is_relative_to(root).then(|| Self {
            anchor: 0,
            parts: self.parts[root.parts.len()..].to_vec(),
        })
    }
    pub fn codepoints(&self) -> Vec<u32> {
        let mut result = vec![47; usize::from(self.anchor)];
        for (index, part) in self.parts.iter().enumerate() {
            if index > 0 {
                result.push(47);
            }
            result.extend_from_slice(part);
        }
        if result.is_empty() {
            result.push(46);
        }
        result
    }
    pub fn parent(&self) -> Self {
        let mut result = self.clone();
        result.parts.pop();
        result
    }
    /// POSIX join: an absolute right operand replaces the entire left path.
    pub fn join(&self, other: &Self) -> Self {
        if other.is_absolute() {
            return other.clone();
        }
        let mut result = self.clone();
        result.parts.extend_from_slice(&other.parts);
        result
    }
    pub fn is_relative_to(&self, other: &Self) -> bool {
        self.anchor == other.anchor && self.parts.starts_with(&other.parts)
    }
    pub fn overlaps(&self, other: &Self) -> bool {
        self.is_relative_to(other) || other.is_relative_to(self)
    }
}
