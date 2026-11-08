//! The approval record: the one gate for every write. A reviewer's GO is bound to exact objects,
//! so a write happens only for the commit, patch, title and body that were reviewed. Any drift
//! (an amended commit, a rebased base, an edited body) refuses before anything leaves the seat.
use crate::{git::Git, sha256_hex};
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Approval {
    /// Must be true: a record written for anything else does not authorize a write.
    pub publication_authorized: bool,
    /// `OWNER/NAME` of the repository the write targets.
    pub repo: String,
    /// The reviewed head commit and its tree.
    pub head: String,
    pub tree: String,
    /// sha256 of `git cat-file commit <head>`: author, committer, dates, parents and message.
    pub raw_commit_sha256: String,
    /// The base the reviewed patch is taken against, and sha256 of
    /// `git diff --binary --full-index <base> <head>`.
    pub base: String,
    pub patch_sha256: String,
    /// sha256 of the reviewed title line (its first line, trimmed, with no newline) and of the
    /// reviewed body file's exact bytes, when the write sets them.
    #[serde(default)]
    pub title_sha256: Option<String>,
    #[serde(default)]
    pub body_sha256: Option<String>,
    /// Who approved, and where (message ids or receipt seals), for the record.
    pub reviews: Vec<String>,
}

impl Approval {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        serde_json::from_str(&text).map_err(|e| format!("approval record: {e}"))
    }

    /// Checks the record against what is about to be written: `head` and `base` are the full ids
    /// the caller checked (and will write), `text` the title and body it will set. The record must
    /// name exactly that head and base, so an approval for one revision never covers another.
    pub fn verify(
        &self,
        git: &Git,
        repo: &str,
        head: &str,
        base: &str,
        text: Option<(&str, &str)>,
    ) -> Result<(), String> {
        if !self.publication_authorized {
            return Err("the approval record does not authorize publication".into());
        }
        if self.repo != repo {
            return Err(format!("the approval is for {}, not {repo}", self.repo));
        }
        if self.reviews.is_empty() {
            return Err("the approval names no review".into());
        }
        let resolve = |rev: &str| {
            git.run([
                "rev-parse",
                "--verify",
                "--end-of-options",
                &format!("{rev}^{{commit}}"),
            ])
        };
        if resolve(&self.head)? != self.head || self.head != head {
            return Err("the approval is for another head".into());
        }
        if resolve(&self.base)? != self.base || self.base != base {
            return Err("the approval is for another base".into());
        }
        if git.run(["rev-parse", &format!("{head}^{{tree}}")])? != self.tree {
            return Err("the head's tree is not the approved tree".into());
        }
        let raw = git.bytes(["cat-file", "commit", head])?;
        if sha256_hex(&raw) != self.raw_commit_sha256 {
            return Err("the head commit object is not the approved one".into());
        }
        let patch = git.bytes([
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--binary",
            "--full-index",
            "--end-of-options",
            base,
            head,
        ])?;
        if sha256_hex(&patch) != self.patch_sha256 {
            return Err("the patch against the approved base is not the approved patch".into());
        }
        match (text, &self.title_sha256, &self.body_sha256) {
            (None, None, None) => Ok(()),
            (Some((title, body)), Some(t), Some(b)) => {
                if &sha256_hex(title.as_bytes()) != t {
                    return Err("the title is not the approved title".into());
                }
                if &sha256_hex(body.as_bytes()) != b {
                    return Err("the body is not the approved body".into());
                }
                Ok(())
            }
            (Some(_), _, _) => {
                Err("the packet sets a title and body the approval does not cover".into())
            }
            (None, _, _) => {
                Err("the approval covers a title and body the packet does not carry".into())
            }
        }
    }
}
