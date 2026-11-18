use super::{content, display, lines, shown, within};
use crate::protocol::{Reply, Result, bounded_integer, prefix};
use reverie_core::{PythonTextRef, python_glob::PythonGlob};
use reverie_python_regex::CompiledPattern;
use serde::Deserialize;
use std::{
    ffi::OsStr,
    fs, io,
    path::{Path, PathBuf},
};

const MAX_ENTRIES: usize = 500;
const MAX_SEARCH_FILES: usize = 5000;
const MAX_HITS: usize = 200;
const MAX_PATTERN: usize = 500;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListArgs {
    path: Option<String>,
    depth: Option<usize>,
}

fn selected_path(path: Option<&str>) -> &str {
    path.filter(|path| !path.is_empty()).unwrap_or(".")
}

pub(crate) fn list(root: &Path, args: ListArgs, limit: usize) -> Result<Reply> {
    let relative = selected_path(args.path.as_deref());
    let directory = within(root, relative, false)?;
    if !directory.is_dir() {
        return Err(format!("{relative}: not a directory").into());
    }
    let depth = bounded_integer(args.depth, "depth", 2, 3)?;
    let mut listing = Listing::default();
    listing.walk(root, &directory, depth);
    let omitted = listing.total > MAX_ENTRIES;
    let mut text = listing.entries.join("\n");
    if text.is_empty() {
        text.push_str("[empty directory]");
    }
    if omitted {
        text.push_str(&format!(
            "\n[truncated: showing {MAX_ENTRIES} of {} entries]",
            listing.total
        ));
    }
    Ok(shown(text, limit, omitted))
}

#[derive(Default)]
struct Listing {
    entries: Vec<String>,
    total: usize,
}

impl Listing {
    fn walk(&mut self, root: &Path, directory: &Path, depth: usize) {
        let entries = match entries(directory) {
            Ok(entries) => entries,
            Err(error) => {
                if self.entries.len() < MAX_ENTRIES {
                    self.entries.push(format!(
                        "{}/ [unreadable: {error}]",
                        display(root, directory)
                    ));
                }
                return;
            }
        };
        for entry in entries {
            let path = entry.path();
            let (directory, suffix) = match entry.file_type() {
                Ok(kind) if kind.is_symlink() => (false, "@"),
                Ok(kind) if kind.is_dir() => (true, "/"),
                _ => (false, ""),
            };
            self.total += 1;
            if self.entries.len() < MAX_ENTRIES {
                self.entries
                    .push(format!("{}{suffix}", display(root, &path)));
            }
            if directory && entry.file_name() != ".git" && depth > 1 {
                self.walk(root, &path, depth - 1);
            }
        }
    }
}

fn entries(dir: &Path) -> io::Result<Vec<fs::DirEntry>> {
    let mut entries: Vec<_> = fs::read_dir(dir)?.collect::<io::Result<_>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    Ok(entries)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SearchArgs {
    pattern: String,
    path: Option<String>,
    fixed: Option<bool>,
    glob: Option<String>,
}

enum Pattern {
    Literal(String),
    Regex(CompiledPattern),
}

impl Pattern {
    fn new(pattern: String, literal: bool) -> Result<Self> {
        if !(1..=MAX_PATTERN).contains(&pattern.chars().count()) {
            return Err(format!("pattern must be 1 to {MAX_PATTERN} chars").into());
        }
        if literal {
            return Ok(Self::Literal(pattern));
        }
        CompiledPattern::compile_case_sensitive(PythonTextRef::from_scalar_text(&pattern))
            .map(Self::Regex)
            .map_err(|error| format!("bad regular expression: {error}").into())
    }

    fn matches(&self, text: &str) -> bool {
        match self {
            Self::Literal(pattern) => text.contains(pattern),
            Self::Regex(pattern) => pattern.is_match(PythonTextRef::from_scalar_text(text)),
        }
    }
}

struct Search<'a> {
    root: &'a Path,
    pattern: Pattern,
    glob: Option<PythonGlob>,
    hits: Vec<String>,
    total: usize,
    examined: usize,
    skipped: usize,
}

pub(crate) fn search(root: &Path, args: SearchArgs, limit: usize) -> Result<Reply> {
    let pattern = Pattern::new(args.pattern, args.fixed.unwrap_or_default())?;
    let relative = selected_path(args.path.as_deref());
    let base = within(root, relative, false)?;
    if !base.exists() {
        return Err(format!("{relative}: no such file or directory").into());
    }
    let glob = args
        .glob
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(|text| PythonGlob::compile(PythonTextRef::from_scalar_text(text)));
    let mut state = Search {
        root,
        pattern,
        glob,
        hits: Vec::new(),
        total: 0,
        examined: 0,
        skipped: 0,
    };
    if base.is_dir() {
        state.walk(base);
    } else {
        state.file(&base);
    }
    Ok(state.finish(limit))
}

impl Search<'_> {
    fn walk(&mut self, root: PathBuf) {
        let mut pending = vec![root];
        while let Some(directory) = pending.pop() {
            pending.extend(self.directory(&directory).into_iter().rev());
        }
    }

    fn directory(&mut self, directory: &Path) -> Vec<PathBuf> {
        let Ok(entries) = entries(directory) else {
            return Vec::new();
        };
        let mut children = Vec::new();
        for entry in entries {
            let path = entry.path();
            match entry.file_type() {
                Ok(kind) if kind.is_dir() && entry.file_name() != ".git" => children.push(path),
                Ok(kind) if !kind.is_dir() && !path.is_dir() => self.file(&path),
                _ => {}
            }
        }
        children
    }

    fn file(&mut self, path: &Path) {
        let relative = display(self.root, path);
        if let Some(glob) = &self.glob {
            let name = path.file_name().unwrap_or(OsStr::new("")).to_string_lossy();
            if !glob.is_match(PythonTextRef::from_scalar_text(&relative))
                && !glob.is_match(PythonTextRef::from_scalar_text(&name))
            {
                return;
            }
        }
        if self.examined >= MAX_SEARCH_FILES {
            self.skipped += 1;
            return;
        }
        let Ok(real) = fs::canonicalize(path) else {
            self.skipped += 1;
            return;
        };
        if !real.starts_with(self.root) {
            self.skipped += 1;
            return;
        }
        self.examined += 1;
        let Ok((bytes, _)) = content::read_bytes(&real, &relative) else {
            self.skipped += 1;
            return;
        };
        if content::binary(&bytes) {
            return;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (offset, line) in lines(&text).enumerate() {
            if !self.pattern.matches(line) {
                continue;
            }
            self.total += 1;
            if self.hits.len() < MAX_HITS {
                self.hits
                    .push(format!("{relative}:{}:{}", offset + 1, prefix(line, 300)));
            }
        }
    }

    fn finish(self, limit: usize) -> Reply {
        let mut text = self.hits.join("\n");
        if text.is_empty() {
            text.push_str("[no matches]");
        }
        let truncated = self.total > self.hits.len();
        let mut notes = Vec::new();
        if truncated {
            notes.push(format!(
                "showing {} of {} matches",
                self.hits.len(),
                self.total
            ));
        }
        if self.skipped > 0 {
            notes.push(format!("{} file(s) skipped (too large, unreadable, outside or over the {MAX_SEARCH_FILES}-file limit)", self.skipped));
        }
        if !notes.is_empty() {
            text.push_str(&format!("\n[{}]", notes.join("; ")));
        }
        shown(text, limit, truncated)
    }
}
