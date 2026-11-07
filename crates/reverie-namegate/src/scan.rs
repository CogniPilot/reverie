//! Findings with the reference grouping and order, reported as list indices only.

use crate::clean::clean;
use crate::lists::Lists;
use crate::tokens::{literal_parts, matches, tokens};
use std::collections::{BTreeMap, BTreeSet};

/// What kind of entry matched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Category {
    Team,
    Internal,
    Path,
    AiWord,
    AiPhrase,
}

impl Category {
    /// Stable report name.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::Team => "team",
            Self::Internal => "internal",
            Self::Path => "path",
            Self::AiWord => "ai_word",
            Self::AiPhrase => "ai_phrase",
        }
    }
}

/// One finding: a category, the index of the list entry, and whether it was found only inside a
/// stripped base64-like blob (which needs a manual check, never an automatic pass). The matched
/// text is deliberately not part of the type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Finding {
    pub category: Category,
    pub index: usize,
    pub in_blob: bool,
}

/// `Text` for commit and PR text (AI words block); `Code` for diff lines (AI words only flag).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Code,
}

/// Blocking findings and findings that need a look.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub blocking: Vec<Finding>,
    pub flagged: Vec<Finding>,
}

/// A finding with the sort key the reference orders by and the character offset of its first
/// occurrence in normalised text. Neither leaves this module except as a column number.
struct Keyed {
    key: String,
    at: usize,
    finding: Finding,
}

struct Grouped {
    blocking: Vec<Keyed>,
    flagged: Vec<Keyed>,
}

/// Scans `text` for `repo` (the reference `scan`).
#[must_use]
pub fn scan(lists: &Lists, text: &str, kind: Kind, repo: &str) -> Outcome {
    let grouped = grouped(lists, text, kind, repo);
    let plain = |v: Vec<Keyed>| v.into_iter().map(|k| k.finding).collect();
    Outcome {
        blocking: plain(grouped.blocking),
        flagged: plain(grouped.flagged),
    }
}

/// Strict form for publishing: blocking findings plus every blob finding (the reference `hits`).
#[must_use]
pub fn hits(lists: &Lists, text: &str, kind: Kind, repo: &str) -> Vec<Finding> {
    let outcome = scan(lists, text, kind, repo);
    outcome
        .blocking
        .into_iter()
        .chain(outcome.flagged.into_iter().filter(|f| f.in_blob))
        .collect()
}

/// Findings of one line with the 1-based column of their first occurrence in the line's
/// normalised text (after NFKC and dropping format characters), blocking then flagged.
#[must_use]
pub fn locate(lists: &Lists, line: &str, kind: Kind, repo: &str) -> Vec<(Finding, usize)> {
    let grouped = grouped(lists, line, kind, repo);
    grouped
        .blocking
        .into_iter()
        .chain(grouped.flagged)
        .map(|k| (k.finding, k.at + 1))
        .collect()
}

fn grouped(lists: &Lists, text: &str, kind: Kind, repo: &str) -> Grouped {
    let (cleaned, blobs) = clean(text, &lists.allow);
    let (block, toks) = block_findings(lists, &cleaned, repo, false);
    let mut ai = word_findings(&toks, &lists.ai_words, Category::AiWord, false);
    ai.extend(phrase_findings(lists, &cleaned));
    let blob_flags = blob_findings(lists, &blobs, repo);
    match kind {
        Kind::Text => Grouped {
            blocking: block.into_iter().chain(ai).collect(),
            flagged: blob_flags,
        },
        Kind::Code => Grouped {
            blocking: block,
            flagged: ai.into_iter().chain(blob_flags).collect(),
        },
    }
}

fn block_findings(
    lists: &Lists,
    text: &str,
    repo: &str,
    in_blob: bool,
) -> (Vec<Keyed>, BTreeMap<String, usize>) {
    let toks = tokens(text);
    let mut block = word_findings(&toks, &lists.team, Category::Team, in_blob);
    let home = repo == lists.home_repo;
    if !home {
        block.extend(word_findings(
            &toks,
            &lists.internal,
            Category::Internal,
            in_blob,
        ));
    }
    let mut seen = BTreeSet::new();
    let mut paths: Vec<Keyed> = matches(text, &lists.path_markers)
        .into_iter()
        .filter(|(_, matched, _)| {
            !home || !matched.to_lowercase().starts_with(lists.home_repo.as_str())
        })
        .filter(|(_, matched, _)| seen.insert(matched.clone()))
        .map(|(index, matched, at)| Keyed {
            key: matched,
            at,
            finding: Finding {
                category: Category::Path,
                index,
                in_blob,
            },
        })
        .collect();
    paths.sort_by(|a, b| a.key.cmp(&b.key));
    block.extend(paths);
    (block, toks)
}

/// Entries present in the token set, ordered by entry text like the reference `sorted(set & set)`.
fn word_findings(
    toks: &BTreeMap<String, usize>,
    entries: &[String],
    category: Category,
    in_blob: bool,
) -> Vec<Keyed> {
    let mut found: Vec<Keyed> = entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            toks.get(entry.as_str()).map(|&at| Keyed {
                key: entry.clone(),
                at,
                finding: Finding {
                    category,
                    index,
                    in_blob,
                },
            })
        })
        .collect();
    found.sort_by(|a, b| a.key.cmp(&b.key));
    found.dedup_by(|a, b| a.key == b.key);
    found
}

fn phrase_findings(lists: &Lists, text: &str) -> Vec<Keyed> {
    let parts: Vec<_> = lists.ai_phrases.iter().map(|p| literal_parts(p)).collect();
    let mut seen = BTreeSet::new();
    let mut found: Vec<Keyed> = matches(text, &parts)
        .into_iter()
        .filter(|(_, matched, _)| seen.insert(matched.clone()))
        .map(|(index, matched, at)| Keyed {
            key: matched,
            at,
            finding: Finding {
                category: Category::AiPhrase,
                index,
                in_blob: false,
            },
        })
        .collect();
    found.sort_by(|a, b| a.key.cmp(&b.key));
    found
}

/// Each stripped blob is re-scanned raw; results are the union, ordered by their reference
/// string (`"blob:" + matched`), located at the blob.
fn blob_findings(lists: &Lists, blobs: &[(usize, String)], repo: &str) -> Vec<Keyed> {
    let mut seen = BTreeSet::new();
    let mut found: Vec<Keyed> = blobs
        .iter()
        .flat_map(|(at, blob)| {
            block_findings(lists, blob, repo, true)
                .0
                .into_iter()
                .map(move |keyed| Keyed { at: *at, ..keyed })
        })
        .filter(|keyed| seen.insert(keyed.key.clone()))
        .collect();
    found.sort_by(|a, b| a.key.cmp(&b.key));
    found
}
