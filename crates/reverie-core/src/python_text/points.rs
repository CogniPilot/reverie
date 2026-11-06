//! Python str codepoint data, including NUL and lone surrogates. OS encoding,
//! path policy and authority remain the consuming purpose's responsibility.
use std::fmt;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PythonTextError;
impl fmt::Display for PythonTextError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str("PYTHON_TEXT_CODEPOINT")
    }
}
impl std::error::Error for PythonTextError {}
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct PythonText(Vec<u32>);
pub(super) fn check(points: &[u32]) -> Result<(), PythonTextError> {
    if points.iter().any(|&point| point > 0x10ffff) {
        Err(PythonTextError)
    } else {
        Ok(())
    }
}
impl PythonText {
    pub fn try_new(points: Vec<u32>) -> Result<Self, PythonTextError> {
        check(&points)?;
        Ok(Self(points))
    }
    pub fn from_scalar_text(text: &str) -> Self {
        Self(text.chars().map(u32::from).collect())
    }
    pub fn codepoints(&self) -> &[u32] {
        &self.0
    }
    pub fn into_codepoints(self) -> Vec<u32> {
        self.0
    }
    pub fn equals_ascii(&self, text: &str) -> bool {
        self.0.iter().copied().eq(text.bytes().map(u32::from))
    }
    pub fn from_text_ref(value: super::PythonTextRef<'_>) -> Self {
        Self(value.codepoints().into_owned())
    }
    pub fn as_text_ref(&self) -> super::PythonTextRef<'_> {
        super::PythonTextRef::from_owned(self)
    }
}
