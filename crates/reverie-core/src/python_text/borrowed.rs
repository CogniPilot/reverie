//! Borrowed lossless Python str view, with the same invariant as owned text.
use super::{PythonText, PythonTextError};
use std::borrow::Cow;
#[derive(Clone, Copy, Debug)]
pub struct PythonTextRef<'a>(Repr<'a>);
#[derive(Clone, Copy, Debug)]
enum Repr<'a> {
    Scalar(&'a str),
    Codepoints(&'a [u32]),
}
impl<'a> PythonTextRef<'a> {
    pub fn from_scalar_text(value: &'a str) -> Self {
        Self(Repr::Scalar(value))
    }
    pub fn from_codepoints(value: &'a [u32]) -> Result<Self, PythonTextError> {
        super::points::check(value)?;
        Ok(Self(Repr::Codepoints(value)))
    }
    pub fn from_owned(value: &'a PythonText) -> Self {
        Self(Repr::Codepoints(value.codepoints()))
    }
    pub fn codepoints(&self) -> Cow<'a, [u32]> {
        match self.0 {
            Repr::Scalar(value) => Cow::Owned(value.chars().map(u32::from).collect()),
            Repr::Codepoints(value) => Cow::Borrowed(value),
        }
    }
    pub fn scalar_text(&self) -> Option<Cow<'a, str>> {
        match self.0 {
            Repr::Scalar(value) => Some(Cow::Borrowed(value)),
            Repr::Codepoints(value) => value
                .iter()
                .map(|&cp| char::from_u32(cp))
                .collect::<Option<String>>()
                .map(Cow::Owned),
        }
    }
    pub fn into_owned(self) -> PythonText {
        PythonText::from_text_ref(self)
    }
    /// UTF-16 units with Python's surrogatepass behavior. Adjacent literal
    /// surrogates remain distinct codepoints; this only encodes each point.
    pub fn utf16_units(&self) -> Vec<u16> {
        let mut units = Vec::new();
        for &point in self.codepoints().iter() {
            if point <= 0xffff {
                units.push(point as u16);
            } else {
                let offset = point - 0x10000;
                units.push(0xd800 | (offset >> 10) as u16);
                units.push(0xdc00 | (offset & 0x3ff) as u16);
            }
        }
        units
    }
    pub fn is_empty(&self) -> bool {
        match self.0 {
            Repr::Scalar(value) => value.is_empty(),
            Repr::Codepoints(value) => value.is_empty(),
        }
    }
    pub fn trimmed(&self) -> Self {
        match self.0 {
            Repr::Scalar(value) => Self::from_scalar_text(super::trim_text(value)),
            Repr::Codepoints(value) => Self(Repr::Codepoints(trim(value))),
        }
    }
    pub fn take(&self, maximum: usize) -> Self {
        match self.0 {
            Repr::Scalar(value) => Self::from_scalar_text(
                &value[..value
                    .char_indices()
                    .nth(maximum)
                    .map_or(value.len(), |(index, _)| index)],
            ),
            Repr::Codepoints(value) => Self(Repr::Codepoints(&value[..value.len().min(maximum)])),
        }
    }
}
fn whitespace(point: u32) -> bool {
    char::from_u32(point).is_some_and(super::whitespace)
}
fn trim(value: &[u32]) -> &[u32] {
    let first = value
        .iter()
        .position(|&cp| !whitespace(cp))
        .unwrap_or(value.len());
    let end = value
        .iter()
        .rposition(|&cp| !whitespace(cp))
        .map_or(first, |index| index + 1);
    &value[first..end]
}
impl PartialEq<&str> for PythonTextRef<'_> {
    fn eq(&self, other: &&str) -> bool {
        self.codepoints()
            .iter()
            .copied()
            .eq(other.chars().map(u32::from))
    }
}
