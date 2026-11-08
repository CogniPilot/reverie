//! `reverie-publish`: reviewed publication from sealed packets. `check` runs every shared check
//! against a packet and an object store, writing only into that local store (the imported objects,
//! through a private bundle copy it removes). `merge` runs the same checks, then GitHub's, and
//! merges the PR with a merge commit.
use clap::{Parser, Subcommand};
use reverie_namegate::{Kind, Lists};
use reverie_publish::{
    approval::Approval,
    commits,
    git::Git,
    github::{API, Curl, Repo},
    merge,
    packet::Packet,
    record::Records,
    sha256_hex, short_name,
};
use serde_json::{Value, json};
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
    /// and the approval record when given. Writes only into the local object store (the imported
    /// bundle); nothing is pushed or sent.
    Check(Check),
    /// Merge a PR with a merge commit after every check passes: the packet checks above with an
    /// approval record that names this PR, then GitHub's: the PR is open at --head with the
    /// reviewed title and body and reported clean, every check run on that head passed, and its
    /// title, body, comments and reviews pass rule 8. Records the intent first and reads the
    /// merge back.
    Merge(Merge),
}

#[derive(clap::Args)]
struct Merge {
    #[command(flatten)]
    check: Check,
    /// The PR number.
    #[arg(long)]
    pr: u64,
    /// Directory for the intent, result and readback records.
    #[arg(long)]
    records: PathBuf,
    /// The file holding only the token.
    #[arg(long)]
    token_file: PathBuf,
    /// A private directory for the request body.
    #[arg(long)]
    scratch: PathBuf,
    /// The GitHub API base (a loopback test server is the only alternative).
    #[arg(long, default_value = API)]
    api_base: String,
    /// Run every check and read, then stop before the merge.
    #[arg(long)]
    dry: bool,
}

#[derive(clap::Args)]
struct Check {
    /// The sealed packet directory; its path must not pass through a symlink.
    #[arg(long)]
    packet: PathBuf,
    /// The packet's seal: leading hex digits of sha256(SHA256SUMS), at least 8.
    #[arg(long)]
    seal: String,
    /// The bare object store the bundle is imported into; its path must not pass through a
    /// symlink.
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
        Action::Merge(options) => merge(&options),
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

fn check(o: &Check) -> Result<Value, String> {
    let approval = o.approval.as_deref().map(Approval::load).transpose()?;
    Ok(verify_packet(o, approval.as_ref())?.0)
}

/// A packet's title and body.
type PacketText = (String, String);

/// Every packet check, with `approval` (already loaded, never read again) verified against the
/// exact head, base, title and body; returns the summary and the packet's title and body.
fn verify_packet(
    o: &Check,
    approval: Option<&Approval>,
) -> Result<(Value, Option<PacketText>), String> {
    let name = short_name(&o.repo)?;
    let lists =
        Lists::load(&o.lists, &o.lists_sha256).map_err(|e| format!("namegate lists: {e:?}"))?;
    let packet = Packet::open(&o.packet, &o.seal)?;
    let git = Git::open(&o.git_dir)?;
    // git reads a private copy of the verified bytes, never the packet's path.
    let imported = git.import_bundle(&packet.bundle()?, "check")?;
    let head = git.run([
        "rev-parse",
        "--verify",
        "--end-of-options",
        &format!("{}^{{commit}}", o.head),
    ])?;
    if head != o.head {
        return Err("--head must be the full id of a commit in the bundle".into());
    }
    // Not just any commit in the store: the tip of a ref the sealed bundle itself carries.
    if !git.is_imported_tip(&imported, &head)? {
        return Err("--head must be the tip of a ref in the sealed bundle".into());
    }
    let tree = git.run(["rev-parse", &format!("{head}^{{tree}}")])?;
    if o.tree.len() < 8 || !tree.starts_with(&o.tree) {
        return Err("the head's tree is not the reviewed tree".into());
    }
    let base = git.store_revision(&o.base)?;
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
    if let Some(approval) = approval {
        approval.verify(
            &git,
            &o.repo,
            &head,
            &base,
            text.as_ref().map(|(t, b)| (t.as_str(), b.as_str())),
        )?;
    }
    let summary = json!({
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
        "approval": approval.is_some(),
    });
    Ok((summary, text))
}

fn merge(o: &Merge) -> Result<Value, String> {
    let path = o
        .check
        .approval
        .as_ref()
        .ok_or("merging needs --approval")?;
    // One read of the record: the merge permission and every object and text check below use this
    // same value, so records swapped at the path between reads can never combine their permissions.
    let approval = Approval::load(path)?;
    if approval.merge_pr != Some(o.pr) {
        return Err(format!(
            "the approval record does not authorize merging PR {}",
            o.pr
        ));
    }
    // Every packet check, the approval against the exact head, base, title and body included.
    let (mut summary, text) = verify_packet(&o.check, Some(&approval))?;
    let (title, body) =
        text.ok_or("merging needs the reviewed TITLE.txt and BODY.md in the packet")?;
    let name = short_name(&o.check.repo)?;
    let lists = Lists::load(&o.check.lists, &o.check.lists_sha256)
        .map_err(|e| format!("namegate lists: {e:?}"))?;
    let curl = Curl::new(&o.token_file, &o.scratch, &o.api_base)?;
    let api = Repo {
        transport: &curl,
        name: o.check.repo.clone(),
    };
    let (number, head) = (o.pr, o.check.head.as_str());
    let pr = api.call("GET", &format!("/pulls/{number}"), None)?;
    merge::ready(&pr, number, head, &title, &body)?;
    let runs = api.call(
        "GET",
        &format!("/commits/{head}/check-runs?per_page=100"),
        None,
    )?;
    let status = api.call("GET", &format!("/commits/{head}/status"), None)?;
    let check_runs = merge::checks_green(&runs, &status, head)?;
    let comments = api.call(
        "GET",
        &format!("/issues/{number}/comments?per_page=100"),
        None,
    )?;
    let reviews = api.call(
        "GET",
        &format!("/pulls/{number}/reviews?per_page=100"),
        None,
    )?;
    let review_comments = api.call(
        "GET",
        &format!("/pulls/{number}/comments?per_page=100"),
        None,
    )?;
    for (what, text) in merge::public_texts(&pr, &comments, &reviews, &review_comments)? {
        commits::clean(&lists, &text, Kind::Text, name, &what)?;
    }
    summary["pr"] = json!(number);
    summary["checkRuns"] = json!(check_runs);
    if o.dry {
        return Ok(summary);
    }
    let records = Records::new(&o.records)?;
    records.intent(&json!({
        "action": "merge",
        "repo": o.check.repo,
        "pr": number,
        "head": head,
        "mergeMethod": "merge",
        "packetSeal": o.check.seal,
        "approval": path,
    }))?;
    // `sha` makes GitHub refuse if the head moved after these checks.
    let result = api.call(
        "PUT",
        &format!("/pulls/{number}/merge"),
        Some(&json!({ "merge_method": "merge", "sha": head })),
    )?;
    records.result("MERGE-RESULT.json", &result)?;
    let sha = merge::merge_reply(&result)?;
    let after = api.call("GET", &format!("/pulls/{number}"), None)?;
    records.result("PR-READBACK.json", &after)?;
    let commit = api.call("GET", &format!("/commits/{sha}"), None)?;
    records.result("MERGE-COMMIT-READBACK.json", &commit)?;
    merge::merged(&after, &commit, number, head, &sha)?;
    summary["merged"] = json!(true);
    summary["mergeCommit"] = json!(sha);
    Ok(summary)
}
