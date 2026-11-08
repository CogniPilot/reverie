//! Every shared check, in order, for one packet against one base. Each writing subcommand runs
//! this first; `check` runs only this.
use crate::{approval::Approval, commits, git::Git, packet::Packet, sha256_hex, short_name};
use reverie_namegate::{Kind, Lists};
use serde_json::{Value, json};
use std::path::Path;

/// What a packet is checked against.
pub struct Inputs<'a> {
    pub packet: &'a Path,
    pub seal: &'a str,
    /// The held object store; the verified bundle is imported through a private copy in it.
    pub git: &'a Git,
    /// `OWNER/NAME`.
    pub repo: &'a str,
    /// The base, as a revision in the object store.
    pub base: &'a str,
    pub head: &'a str,
    /// At least 8 leading hex digits of the reviewed tree.
    pub tree: &'a str,
    pub lists: &'a Lists,
    /// Required for any write; optional for `check`.
    pub approval: Option<&'a Path>,
}

/// A packet that passed, with what a write needs from it.
#[derive(Debug)]
pub struct Verified {
    pub head: String,
    pub base: String,
    pub text: Option<(String, String)>,
    pub summary: Value,
}

pub fn verify(input: &Inputs<'_>) -> Result<Verified, String> {
    let name = short_name(input.repo)?;
    let packet = Packet::open(input.packet, input.seal)?;
    let git = input.git;
    // git reads a private copy of the verified bytes, never the packet's path.
    git.import_bundle(&packet.bundle()?, "packet")?;
    let head = git.run([
        "rev-parse",
        "--verify",
        "--end-of-options",
        &format!("{}^{{commit}}", input.head),
    ])?;
    if head != input.head {
        return Err("--head must be the full id of a commit in the bundle".into());
    }
    let tree = git.run(["rev-parse", &format!("{head}^{{tree}}")])?;
    if input.tree.len() < 8 || !tree.starts_with(input.tree) {
        return Err("the head's tree is not the reviewed tree".into());
    }
    let base = git.run([
        "rev-parse",
        "--verify",
        "--end-of-options",
        &format!("{}^{{commit}}", input.base),
    ])?;
    let checked = commits::check_range(git, input.lists, name, &[&head, "--not", &base], &head)?;
    let text = packet.text()?;
    if let Some((title, body)) = &text {
        commits::clean(
            input.lists,
            &format!("{title}\n{body}"),
            Kind::Text,
            name,
            "the title and body",
        )?;
    }
    if !git.succeeds(["merge-tree", "--write-tree", &base, &head])? {
        return Err("the head does not merge cleanly with the base".into());
    }
    if let Some(path) = input.approval {
        Approval::load(path)?.verify(
            git,
            input.repo,
            &head,
            &base,
            text.as_ref().map(|(t, b)| (t.as_str(), b.as_str())),
        )?;
    }
    let summary = json!({
        "verified": true,
        "repo": input.repo,
        "head": head,
        "tree": tree,
        "base": base,
        "commits": checked.len(),
        "merges": checked.iter().filter(|c| c.merge).count(),
        "addedLines": checked.iter().map(|c| c.added_lines).sum::<usize>(),
        "title": text.as_ref().map(|(t, _)| t.clone()),
        "bodySha256": text.as_ref().map(|(_, b)| sha256_hex(b.as_bytes())),
        "approval": input.approval.is_some(),
    });
    Ok(Verified {
        head,
        base,
        text,
        summary,
    })
}
