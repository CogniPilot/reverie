//! `reverie-publish`: reviewed publication from sealed packets. This release has `check`, which
//! runs every shared check against a packet and an object store without writing anywhere.
use clap::{Parser, Subcommand};
use reverie_namegate::{Kind, Lists};
use reverie_publish::{
    approval::Approval, commits, git::Git, packet::Packet, sha256_hex, short_name,
};
use std::{path::PathBuf, process::ExitCode};

#[derive(Parser)]
#[command(
    about = "Reviewed publication from sealed packets.",
    after_long_help = "EXIT STATUS:\n  0 when every check passes, 1 when one fails (the message names it), 2 on a usage error."
)]
struct Arguments {
    #[command(subcommand)]
    action: Action,
}

#[derive(Subcommand)]
enum Action {
    /// Check a packet against an object store: seal, bundle, head and tree, every commit beyond
    /// the base (identity, sign-off, rule 8), the title and body, a clean merge with the base,
    /// and the approval record when given. Writes nothing.
    Check(Check),
}

#[derive(clap::Args)]
struct Check {
    /// The sealed packet directory.
    #[arg(long)]
    packet: PathBuf,
    /// The packet's seal: leading hex digits of sha256(SHA256SUMS), at least 8.
    #[arg(long)]
    seal: String,
    /// The bare object store the bundle is imported into.
    #[arg(long)]
    git_dir: PathBuf,
    /// The target repository, OWNER/NAME.
    #[arg(long)]
    repo: String,
    /// The base the PR goes onto, as a revision in the object store.
    #[arg(long)]
    base: String,
    /// The reviewed head commit.
    #[arg(long)]
    head: String,
    /// The reviewed head's tree (at least 8 hex digits).
    #[arg(long)]
    tree: String,
    /// The private namegate list file and its pinned sha256.
    #[arg(long)]
    lists: PathBuf,
    #[arg(long)]
    lists_sha256: String,
    /// An approval record to verify against the same objects and text.
    #[arg(long)]
    approval: Option<PathBuf>,
}

fn main() -> ExitCode {
    let result = match Arguments::parse().action {
        Action::Check(options) => check(&options),
    };
    match result {
        Ok(summary) => {
            println!("{summary}");
            ExitCode::SUCCESS
        }
        Err(reason) => {
            eprintln!("reverie-publish: {reason}");
            ExitCode::FAILURE
        }
    }
}

fn check(o: &Check) -> Result<serde_json::Value, String> {
    let name = short_name(&o.repo)?;
    let lists =
        Lists::load(&o.lists, &o.lists_sha256).map_err(|e| format!("namegate lists: {e:?}"))?;
    let packet = Packet::open(&o.packet, &o.seal)?;
    let git = Git::new(&o.git_dir);
    git.import_bundle(&packet.bundle()?, "check")?;
    let head = git.run(["rev-parse", "--verify", &format!("{}^{{commit}}", o.head)])?;
    if head != o.head {
        return Err("--head must be the full id of a commit in the bundle".into());
    }
    let tree = git.run(["rev-parse", &format!("{head}^{{tree}}")])?;
    if o.tree.len() < 8 || !tree.starts_with(&o.tree) {
        return Err("the head's tree is not the reviewed tree".into());
    }
    let base = git.run(["rev-parse", "--verify", &format!("{}^{{commit}}", o.base)])?;
    let checked = commits::check_range(&git, &lists, name, &[&head, "--not", &base], &head)?;
    let text = packet.text()?;
    if let Some((title, body)) = &text {
        commits::clean(
            &lists,
            &format!("{title}\n{body}"),
            Kind::Text,
            name,
            "the title and body",
        )?;
    }
    if !git.succeeds(["merge-tree", "--write-tree", &base, &head])? {
        return Err("the head does not merge cleanly with the base".into());
    }
    if let Some(path) = &o.approval {
        let approval = Approval::load(path)?;
        approval.verify(
            &git,
            &o.repo,
            text.as_ref().map(|(t, b)| (t.as_str(), b.as_str())),
        )?;
    }
    Ok(serde_json::json!({
        "verified": true,
        "repo": o.repo,
        "head": head,
        "tree": tree,
        "base": base,
        "commits": checked.len(),
        "merges": checked.iter().filter(|c| c.merge).count(),
        "addedLines": checked.iter().map(|c| c.added_lines).sum::<usize>(),
        "title": text.as_ref().map(|(t, _)| t.clone()),
        "bodySha256": text.as_ref().map(|(_, b)| sha256_hex(b.as_bytes())),
        "approval": o.approval.is_some(),
    }))
}
