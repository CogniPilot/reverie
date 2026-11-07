//! Internal-name gate for outbound text: commit messages, pull request text and diffs.
//!
//! This crate holds the algorithm only. What it looks for comes from a private list file that
//! is never part of any repository; it is pinned by SHA-256 and refused when missing, altered or
//! empty. Findings carry a category and a list index, never the matched text, so a gate that
//! fires in a public log does not republish what it blocks.
//!
//! Semantics follow the reviewed reference gate exactly: NFKC normalisation, dropping format
//! characters, exempting genuine PEM/DER bodies and allowlisted strings, stripping long hex runs
//! and re-scanning base64-like blobs, then comparing whole tokens split at non-letters and
//! lower-to-upper case changes, with Python `re` Unicode and case-folding rules.

mod classes;
mod clean;
mod lists;
mod scan;
mod tokens;

pub use lists::{CATEGORIES, ListError, Lists, SCHEMA};
pub use scan::{Category, Finding, Kind, Outcome, hits, locate, scan};

#[cfg(test)]
mod tests;
