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
    /// sha256 of the reviewed title line and of the reviewed body, when the write sets them.
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

    /// Checks the record against the objects in `git` and the text about to be written.
    pub fn verify(&self, git: &Git, repo: &str, text: Option<(&str, &str)>) -> Result<(), String> {
        if !self.publication_authorized {
            return Err("the approval record does not authorize publication".into());
        }
        if self.repo != repo {
            return Err(format!("the approval is for {}, not {repo}", self.repo));
        }
        if self.reviews.is_empty() {
            return Err("the approval names no review".into());
        }
        let head = git.run([
            "rev-parse",
            "--verify",
            &format!("{}^{{commit}}", self.head),
        ])?;
        if head != self.head {
            return Err("the approved head is not a full commit id".into());
        }
        if git.run(["rev-parse", &format!("{head}^{{tree}}")])? != self.tree {
            return Err("the head's tree is not the approved tree".into());
        }
        let raw = git.bytes(["cat-file", "commit", &head])?;
        if sha256_hex(&raw) != self.raw_commit_sha256 {
            return Err("the head commit object is not the approved one".into());
        }
        let patch = git.bytes(["diff", "--binary", "--full-index", &self.base, &head])?;
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
