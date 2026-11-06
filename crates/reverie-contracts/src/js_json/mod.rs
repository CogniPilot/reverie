//! JSON with JavaScript semantics: values as ECMAScript `JSON.parse` builds them and text as V8's
//! `JSON.stringify` writes them. Strings are UTF-16 code units, so lone surrogates survive a round
//! trip. This is not the Python-compatible decoder in `legacy_json`; the two contracts differ.
mod parse;
mod stringify;

pub use parse::{ParseError, parse};
pub use stringify::{number, quote, stringify};

use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(Vec<u16>),
    Array(Vec<Value>),
    Object(Object),
}

/// Own properties in creation order. As `JSON.parse` defines a repeated key, it keeps its first
/// position and takes its last value; `__proto__` is an ordinary key.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Object {
    entries: Vec<(Vec<u16>, Value)>,
    index: HashMap<Vec<u16>, usize>,
}

impl Object {
    pub fn insert(&mut self, key: Vec<u16>, value: Value) {
        match self.index.get(&key) {
            Some(&position) => self.entries[position].1 = value,
            None => {
                self.index.insert(key.clone(), self.entries.len());
                self.entries.push((key, value));
            }
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        let key: Vec<u16> = key.encode_utf16().collect();
        self.index
            .get(&key)
            .map(|&position| &self.entries[position].1)
    }

    /// Entries in creation order (not the order `JSON.stringify` writes them).
    pub fn entries(&self) -> &[(Vec<u16>, Value)] {
        &self.entries
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests;
