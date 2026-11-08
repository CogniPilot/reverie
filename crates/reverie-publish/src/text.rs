//! Text-only writes: a PR's title, body and labels, a new issue, or a closing comment. What is
//! published comes only from a sealed packet, is scanned by namegate, and is bound to its own
//! approval record by the hash of every piece, the action, the PR or issue number, and (for a PR)
//! the head it had when the text was reviewed.
use crate::{commits, packet::Packet, sha256_hex};
use reverie_namegate::{Kind, Lists};
use serde::Deserialize;
use std::path::Path;

/// The pieces a packet carries for a text write. Each is optional; each action says which it
/// needs.
#[derive(Debug, Default)]
pub struct Texts {
    /// The first line of `TITLE.txt` or `PR-TITLE.txt`, trimmed.
    pub title: Option<String>,
    /// `BODY.md`, `PR-BODY.md` or `PR_BODY.md`, exactly.
    pub body: Option<String>,
    /// `COMMENT.md`, exactly.
    pub comment: Option<String>,
    /// `LABELS.txt`, one label per line, and the sha256 of the file's exact bytes.
    pub labels: Option<(Vec<String>, String)>,
}

impl Texts {
    pub fn from_packet(packet: &Packet) -> Result<Self, String> {
        let read = |names: &[&str]| -> Result<Option<String>, String> {
            packet
                .first_of(names)
                .map(|name| {
                    String::from_utf8(packet.read(name)?)
                        .map_err(|_| format!("{name} is not UTF-8"))
                })
                .transpose()
        };
        let title = read(&["TITLE.txt", "PR-TITLE.txt"])?
            .map(|text| text.lines().next().unwrap_or("").trim().to_owned());
        if title.as_deref() == Some("") {
            return Err("the title is empty".into());
        }
        let labels = read(&["LABELS.txt"])?
            .map(|text| {
                let names: Vec<String> = text
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(str::to_owned)
                    .collect();
                let mut unique = names.clone();
                unique.sort();
                unique.dedup();
                if unique.len() != names.len()
                    || names
                        .iter()
                        .any(|n| n.len() > 50 || n.chars().any(char::is_control))
                {
                    return Err(
                        "LABELS.txt holds a repeated, overlong or unprintable label".to_owned()
                    );
                }
                Ok((names, sha256_hex(text.as_bytes())))
            })
            .transpose()?;
        Ok(Self {
            title,
            body: read(&["BODY.md", "PR-BODY.md", "PR_BODY.md"])?,
            comment: read(&["COMMENT.md"])?,
            labels,
        })
    }

    /// Runs namegate over every piece, as one text.
    pub fn scan(&self, lists: &Lists, repo: &str) -> Result<(), String> {
        let pieces: Vec<&str> = [
            self.title.as_deref(),
            self.body.as_deref(),
            self.comment.as_deref(),
        ]
        .into_iter()
        .flatten()
        .chain(
            self.labels
                .iter()
                .flat_map(|(names, _)| names.iter().map(String::as_str)),
        )
        .collect();
        commits::clean(lists, &pieces.join("\n"), Kind::Text, repo, "the text")
    }

    fn hashes(&self) -> [Option<String>; 4] {
        [
            self.title.as_deref().map(|t| sha256_hex(t.as_bytes())),
            self.body.as_deref().map(|b| sha256_hex(b.as_bytes())),
            self.comment.as_deref().map(|c| sha256_hex(c.as_bytes())),
            self.labels.as_ref().map(|(_, sha)| sha.clone()),
        ]
    }
}

/// The approval for one text write.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TextApproval {
    /// Must be true: a record written for anything else does not authorize a write.
    pub publication_authorized: bool,
    /// `OWNER/NAME`.
    pub repo: String,
    /// `pr-text`, `issue-create` or `issue-close`.
    pub action: String,
    /// The PR or issue written to; absent for `issue-create`.
    #[serde(default)]
    pub number: Option<u64>,
    /// The PR's head when the text was reviewed; absent unless the target is a PR.
    #[serde(default)]
    pub head: Option<String>,
    /// sha256 of the title (first line, trimmed), the body, the comment and `LABELS.txt`, each
    /// present exactly when the write publishes it.
    #[serde(default)]
    pub title_sha256: Option<String>,
    #[serde(default)]
    pub body_sha256: Option<String>,
    #[serde(default)]
    pub comment_sha256: Option<String>,
    #[serde(default)]
    pub labels_sha256: Option<String>,
    /// Who approved, and where.
    pub reviews: Vec<String>,
}

/// What a text write is about to do, for `TextApproval::verify`.
#[derive(Debug)]
pub struct Write<'a> {
    pub repo: &'a str,
    pub action: &'a str,
    pub number: Option<u64>,
    pub head: Option<&'a str>,
    pub texts: &'a Texts,
}

impl TextApproval {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        serde_json::from_str(&text).map_err(|e| format!("approval record: {e}"))
    }

    /// The record must authorize publication and name exactly this write: repository, action,
    /// number, head, and the hash of every piece, with no piece approved that is not published
    /// and none published that is not approved.
    pub fn verify(&self, write: &Write<'_>) -> Result<(), String> {
        if !self.publication_authorized {
            return Err("the approval record does not authorize publication".into());
        }
        if self.reviews.is_empty() {
            return Err("the approval names no review".into());
        }
        if self.repo != write.repo {
            return Err(format!(
                "the approval is for {}, not {}",
                self.repo, write.repo
            ));
        }
        if self.action != write.action {
            return Err(format!(
                "the approval is for {}, not {}",
                self.action, write.action
            ));
        }
        if self.number != write.number {
            return Err("the approval is for another PR or issue".into());
        }
        if self.head.as_deref() != write.head {
            return Err("the approval is for another head".into());
        }
        let approved = [
            &self.title_sha256,
            &self.body_sha256,
            &self.comment_sha256,
            &self.labels_sha256,
        ];
        let names = ["title", "body", "comment", "labels"];
        for ((name, approved), actual) in names.iter().zip(approved).zip(write.texts.hashes()) {
            if approved.as_ref().map(|h| h.to_ascii_lowercase()) != actual {
                return Err(format!("the approval does not cover this {name}"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts() -> Texts {
        Texts {
            title: Some("Title".into()),
            body: Some("Body\n".into()),
            comment: None,
            labels: Some((vec!["bug".into()], sha256_hex(b"bug\n"))),
        }
    }

    fn approval() -> TextApproval {
        TextApproval {
            publication_authorized: true,
            repo: "owner/demo".into(),
            action: "pr-text".into(),
            number: Some(7),
            head: Some("a1".into()),
            title_sha256: Some(sha256_hex(b"Title")),
            body_sha256: Some(sha256_hex(b"Body\n")),
            comment_sha256: None,
            labels_sha256: Some(sha256_hex(b"bug\n")),
            reviews: vec!["source GO 0000aaaa".into()],
        }
    }

    fn write(texts: &Texts) -> Write<'_> {
        Write {
            repo: "owner/demo",
            action: "pr-text",
            number: Some(7),
            head: Some("a1"),
            texts,
        }
    }

    #[test]
    fn an_approval_covers_exactly_the_write_it_names() {
        let texts = texts();
        approval().verify(&write(&texts)).unwrap();
        let refused = |change: &dyn Fn(&mut TextApproval), why: &str| {
            let mut record = approval();
            change(&mut record);
            let error = record.verify(&write(&texts)).unwrap_err();
            assert!(error.contains(why), "{error}");
        };
        refused(&|r| r.publication_authorized = false, "does not authorize");
        refused(&|r| r.reviews.clear(), "no review");
        refused(&|r| r.repo = "owner/other".into(), "is for owner/other");
        refused(&|r| r.action = "issue-close".into(), "is for issue-close");
        refused(&|r| r.number = Some(8), "another PR or issue");
        refused(&|r| r.head = Some("b2".into()), "another head");
        refused(
            &|r| r.body_sha256 = Some(sha256_hex(b"Other\n")),
            "this body",
        );
        refused(&|r| r.labels_sha256 = None, "this labels");
        refused(
            &|r| r.comment_sha256 = Some(sha256_hex(b"x")),
            "this comment",
        );
    }
}
