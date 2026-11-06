//! Embedding-domain view of the shared checked Python text owner. OS/SQL
//! scalar conversion remains explicit; this never replaces surrogate data.
use super::EmbeddingError;
use crate::PythonTextRef;
use std::borrow::Cow;
#[derive(Clone, Copy, Debug)]
pub struct EmbeddingText<'a>(PythonTextRef<'a>);
impl<'a> EmbeddingText<'a> {
    pub fn from_scalar_text(text: &'a str) -> Self {
        Self(PythonTextRef::from_scalar_text(text))
    }
    pub fn from_codepoints(text: &'a [u32]) -> Result<Self, EmbeddingError> {
        PythonTextRef::from_codepoints(text)
            .map(Self)
            .map_err(|_| EmbeddingError::InvalidText)
    }
    pub fn from_python_text_ref(text: PythonTextRef<'a>) -> Self {
        Self(text)
    }
    pub fn as_python_text_ref(&self) -> PythonTextRef<'a> {
        self.0
    }
    pub fn codepoints(&self) -> Cow<'a, [u32]> {
        self.0.codepoints()
    }
    pub fn scalar_text(&self) -> Option<Cow<'a, str>> {
        self.0.scalar_text()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn trimmed(&self) -> Self {
        Self(self.0.trimmed())
    }
    pub fn take(&self, maximum: usize) -> Self {
        Self(self.0.take(maximum))
    }
}
impl PartialEq<&str> for EmbeddingText<'_> {
    fn eq(&self, other: &&str) -> bool {
        self.0.eq(other)
    }
}
