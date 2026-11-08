//! `reverie-publish`: reviewed publication from sealed packets. `check` runs every shared check
//! against a packet and an object store, and writes only the imported objects into that local store
//! (through a private bundle copy it removes; refs stay in a private git directory). `mint-merge-main` makes and checks
//! the merge of main into a PR head in a local store and writes a new sealed packet for review.
use clap::{Parser, Subcommand};
use reverie_namegate::{Kind, Lists};
use reverie_publish::{
    approval::Approval, commits, custody::Held, git::Git, mint, packet::Packet, sha256_hex,
    short_name,
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
    /// and the approval record when given. Writes only into the local object store (the imported
    /// bundle); nothing is pushed or sent.
    Check(Check),
    /// Merge main into a PR head in the local object store: PR head first, main second, one
    /// identity with its sign-off, the tree `git merge-tree` computes, and a delta over the head
    /// that is exactly main's own change. Writes a new sealed packet (bundle, commit, deltas,
    /// remerge diff, summary) for review. Nothing is pushed or sent.
    MintMergeMain(MintMergeMain),
}

#[derive(clap::Args)]
struct MintMergeMain {
    /// The bare object store holding both commits; its path must not pass through a symlink.
    #[arg(long)]
    git_dir: PathBuf,
    /// The target repository, OWNER/NAME.
    #[arg(long)]
    repo: String,
    /// The PR's head (full id): the merge's first parent.
    #[arg(long)]
    head: String,
    /// Current main (full id): the merge's second parent.
    #[arg(long)]
    main: String,
    /// The PR's branch, named in the merge subject "Merge main into BRANCH".
    #[arg(long)]
    branch: String,
    /// The private namegate list file and its pinned sha256.
    #[arg(long)]
    lists: PathBuf,
    #[arg(long)]
    lists_sha256: String,
    /// The packet directory to create; it must not exist yet, and its parent must not be
    /// reached through a symlink.
    #[arg(long)]
    out: PathBuf,
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
        Action::MintMergeMain(options) => mint_merge_main(&options),
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
    if let Some(path) = &o.approval {
        let approval = Approval::load(path)?;
        approval.verify(
            &git,
            &o.repo,
            &head,
            &base,
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

fn mint_merge_main(o: &MintMergeMain) -> Result<serde_json::Value, String> {
    let name = short_name(&o.repo)?;
    let lists =
        Lists::load(&o.lists, &o.lists_sha256).map_err(|e| format!("namegate lists: {e:?}"))?;
    let git = Git::open(&o.git_dir)?;
    // Hold the parent before anything is minted, so a bad --out refuses first.
    let parent = o
        .out
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(std::path::Path::new("."));
    Held::open(parent)?;
    if o.out.symlink_metadata().is_ok() {
        return Err(format!(
            "{} exists: a sealed packet is never rewritten",
            o.out.display()
        ));
    }
    let minted = mint::mint(
        &git,
        &lists,
        name,
        &o.head,
        &o.main,
        &format!("Merge main into {}", o.branch),
    )?;
    std::fs::create_dir(&o.out).map_err(|e| format!("{}: {e}", o.out.display()))?;
    let out = Held::open(&o.out)?;
    let bundle = git.bytes([
        "bundle",
        "create",
        "-q",
        "-",
        &format!("refs/publish/mint/{}", minted.commit),
        &format!("^{}", minted.main),
    ])?;
    let summary = serde_json::json!({
        "minted": true,
        "repo": o.repo,
        "commit": minted.commit,
        "tree": minted.tree,
        "parents": [minted.head, minted.main],
        "mergeBase": minted.base,
        "deltaEqualsMain": true,
        "changeLines": mint::change_lines(&minted.delta).len(),
    });
    let raw = git.bytes(["cat-file", "commit", &minted.commit])?;
    let remerge = git.bytes([
        "show",
        "--no-ext-diff",
        "--no-textconv",
        "--remerge-diff",
        "--format=fuller",
        &minted.commit,
    ])?;
    let pretty = serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())? + "\n";
    let files: [(&str, &[u8]); 6] = [
        ("source.bundle", &bundle),
        ("MERGE-COMMIT.txt", &raw),
        ("DELTA-U0.diff", minted.delta.as_bytes()),
        ("MAIN-DELTA-U0.diff", minted.main_delta.as_bytes()),
        ("REMERGE.diff", &remerge),
        ("SUMMARY.json", pretty.as_bytes()),
    ];
    let mut sums = String::new();
    for (file, bytes) in files {
        out.write_new(file, bytes)?;
        sums.push_str(&format!("{}  {file}\n", sha256_hex(bytes)));
    }
    out.write_new("SHA256SUMS", sums.as_bytes())?;
    let mut summary = summary;
    summary["packet"] = serde_json::json!(o.out);
    summary["seal"] = serde_json::json!(&sha256_hex(sums.as_bytes())[..8]);
    Ok(summary)
}
