#![forbid(unsafe_code)]
//! Opaque native Python re.I str compiler/matcher. No public
//! bytecode factory, Python VM, generic executable or external pattern selector.
mod ast;
mod compiler;
mod cursor;
mod error;
mod facts;
mod parser;
pub use error::RegexError;
use reverie_core::PythonTextRef;
use rustpython_sre_engine::{Request, State};
use rustpython_wtf8::{CodePoint, Wtf8Buf};
use std::sync::Arc;
pub struct CompiledPattern {
    code: Vec<u32>,
}
impl CompiledPattern {
    pub fn compile(pattern: PythonTextRef<'_>) -> Result<Self, RegexError> {
        let source: Arc<[u32]> = pattern.codepoints().as_ref().into();
        let parsed = parser::Parser::parse(source.clone())?;
        Ok(Self {
            code: compiler::compile(&parsed, &source)?,
        })
    }
    pub fn is_match(&self, text: PythonTextRef<'_>) -> bool {
        let text: Wtf8Buf = text
            .codepoints()
            .iter()
            .map(|&point| CodePoint::from_u32(point).expect("checked Python text"))
            .collect();
        let count = text.code_points().count();
        State::default().search(Request::new(&*text, 0, count, &self.code, false))
    }
}
pub struct CompiledOutputPolicy {
    patterns: Vec<CompiledPattern>,
}
impl CompiledOutputPolicy {
    /// Every pattern is compiled before any search, preserving the actual
    /// output-policy phase even if an earlier valid rule would match.
    pub fn compile<'a>(
        patterns: impl IntoIterator<Item = PythonTextRef<'a>>,
    ) -> Result<Self, RegexError> {
        Ok(Self {
            patterns: patterns
                .into_iter()
                .map(CompiledPattern::compile)
                .collect::<Result<_, _>>()?,
        })
    }
    pub fn is_match(&self, text: PythonTextRef<'_>) -> bool {
        self.patterns.iter().any(|pattern| pattern.is_match(text))
    }
}
