//! `reverie-publish`: reviewed publication from sealed packets. `check` runs every shared check
//! against a packet and an object store, and writes only the imported objects into that local store
//! (through a private bundle copy it removes; refs stay in a private git directory). `new-pr`
//! pushes a reviewed head to a new branch and opens a draft PR. `mint-merge-main` makes and checks
//! the merge of main into a PR head in a local store and writes a new sealed packet for review.
use clap::{Parser, Subcommand};
use reverie_namegate::Lists;
use reverie_publish::{
    askpass,
    custody::Held,
    git::Git,
    github::{API, Curl, Repo},
    mint,
    record::Records,
    sha256_hex, short_name,
    verify::{Inputs, Verified, verify},
};
use serde_json::{Value, json};
use std::{path::PathBuf, process::ExitCode};

#[derive(Parser)]
#[command(
    about = "Reviewed publication from sealed packets.",
    after_long_help = "EXIT STATUS:\n  0 when every check (and any write) succeeds, 1 when one fails (the message names it),\n  2 on a usage error.\n\nWRITES:\n  A write needs an approval record bound to the exact head, tree, commit object, patch, title\n  and body. It writes INTENT.json to --records first and refuses while one exists, never\n  force-pushes, and reads every result back."
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
    /// Push a reviewed head to a new branch and open a draft PR from it, after every check and
    /// the approval record pass. The branch must not exist yet.
    NewPr(NewPr),
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

/// What every subcommand checks.
#[derive(clap::Args)]
struct Common {
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
    /// The reviewed head commit (full id).
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
}

#[derive(clap::Args)]
struct Check {
    #[command(flatten)]
    common: Common,
    /// The base the PR goes onto, as a revision in the object store.
    #[arg(long)]
    base: String,
    /// An approval record to verify against the same objects and text.
    #[arg(long)]
    approval: Option<PathBuf>,
}

#[derive(clap::Args)]
struct NewPr {
    #[command(flatten)]
    common: Common,
    /// The approval record that authorizes this publication.
    #[arg(long)]
    approval: PathBuf,
    /// The new branch to push the head to.
    #[arg(long)]
    branch: String,
    /// The branch the PR targets. Any branch but `main` is a stacked base, and the head must
    /// contain its current tip.
    #[arg(long, default_value = "main")]
    base_branch: String,
    /// Where to fetch and push; defaults to https://github.com/OWNER/NAME.git. Only that URL is
    /// ever given the token; a local path or file:// URL (for tests) is pushed without it.
    #[arg(long)]
    remote_url: Option<String>,
    /// Directory for the intent, push result and PR readback records.
    #[arg(long)]
    records: PathBuf,
    /// The file holding only the token.
    #[arg(long)]
    token_file: PathBuf,
    /// The GitHub API base (a loopback test server is the only alternative).
    #[arg(long, default_value = API)]
    api_base: String,
    /// Run every check and stop before writing.
    #[arg(long)]
    dry: bool,
}

fn main() -> ExitCode {
    if std::env::var_os(askpass::MODE).is_some_and(|mode| mode == "1") {
        return ask();
    }
    let result = match Arguments::parse().action {
        Action::Check(options) => check(&options),
        Action::NewPr(options) => new_pr(&options),
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

/// Running as git's askpass: print the answer to the prompt in argv[1].
fn ask() -> ExitCode {
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let answer = std::env::var_os(askpass::TOKEN_FILE)
        .ok_or_else(|| "no token file".to_owned())
        .and_then(|path| {
            std::fs::read_to_string(path).map_err(|e| format!("token file: {}", e.kind()))
        })
        .and_then(|token| askpass::answer(&prompt, &token));
    match answer {
        Ok(answer) => {
            println!("{answer}");
            ExitCode::SUCCESS
        }
        Err(reason) => {
            eprintln!("reverie-publish askpass: {reason}");
            ExitCode::FAILURE
        }
    }
}

fn lists(common: &Common) -> Result<Lists, String> {
    Lists::load(&common.lists, &common.lists_sha256).map_err(|e| format!("namegate lists: {e:?}"))
}

fn run_verify(
    common: &Common,
    git: &Git,
    lists: &Lists,
    base: &str,
    approval: Option<&PathBuf>,
) -> Result<Verified, String> {
    verify(&Inputs {
        packet: &common.packet,
        seal: &common.seal,
        git,
        repo: &common.repo,
        base,
        head: &common.head,
        tree: &common.tree,
        lists,
        approval: approval.map(PathBuf::as_path),
    })
}

fn check(o: &Check) -> Result<Value, String> {
    let git = Git::open(&o.common.git_dir)?;
    Ok(run_verify(
        &o.common,
        &git,
        &lists(&o.common)?,
        &o.base,
        o.approval.as_ref(),
    )?
    .summary)
}

/// Where to fetch and push, and whether the token may be used there: only the approved
/// repository's GitHub URL is given credentials. A local path or file:// URL is accepted without
/// them; any other URL is refused, so the token never goes to an unapproved destination.
fn remote(remote_url: Option<&str>, repo: &str) -> Result<(String, bool), String> {
    let approved = format!("https://github.com/{repo}.git");
    match remote_url {
        None => Ok((approved, true)),
        Some(url) if url == approved => Ok((approved, true)),
        Some(url)
            if url.starts_with("file:///") || (url.starts_with('/') && !url.contains("::")) =>
        {
            Ok((url.to_owned(), false))
        }
        Some(url) => Err(format!(
            "--remote-url {url} is neither {approved} nor a local path; the token is never sent elsewhere"
        )),
    }
}

fn new_pr(o: &NewPr) -> Result<Value, String> {
    let c = &o.common;
    let git = Git::open(&c.git_dir)?;
    let lists = lists(c)?;
    let (url, credentials) = remote(o.remote_url.as_deref(), &c.repo)?;
    let base = git.fetch_branch(&url, &o.base_branch, "base")?;
    let verified = run_verify(c, &git, &lists, &base, Some(&o.approval))?;
    let (title, body) = verified
        .text
        .clone()
        .ok_or("a new PR needs a sealed title and body")?;
    let head = verified.head.clone();
    if o.base_branch != "main" && !git.succeeds(["merge-base", "--is-ancestor", &base, &head])? {
        return Err(format!(
            "a PR stacked on {} must contain its current tip",
            o.base_branch
        ));
    }
    let reference = format!("refs/heads/{}", o.branch);
    if git.remote_ref(&url, &reference)?.is_some() {
        return Err(format!("branch {} already exists", o.branch));
    }
    let mut summary = verified.summary;
    summary["branch"] = json!(o.branch);
    summary["baseBranch"] = json!(o.base_branch);
    // Every input a write needs is validated before the first write.
    let curl = Curl::new(&o.token_file, &o.records, &o.api_base)?;
    let token =
        std::fs::read_to_string(&o.token_file).map_err(|e| format!("token file: {}", e.kind()))?;
    askpass::token(&token)?;
    if o.dry {
        return Ok(summary);
    }
    let records = Records::new(&o.records)?;
    records.intent(&json!({
        "action": "new-pr",
        "repo": c.repo,
        "head": head,
        "base": base,
        "ref": reference,
        "force": false,
        "packetSeal": c.seal,
        "approval": o.approval,
    }))?;
    let token_file = credentials.then_some(o.token_file.as_path());
    let (pushed, stderr) = git.push_new(&url, &head, &reference, token_file)?;
    records.result(
        "PUSH-RESULT.json",
        &json!({ "ok": pushed, "stderr": stderr }),
    )?;
    if !pushed {
        return Err("the push failed; inspect PUSH-RESULT.json, and do not retry blindly".into());
    }
    if git.remote_ref(&url, &reference)?.as_deref() != Some(head.as_str()) {
        return Err("the pushed branch does not read back as the head".into());
    }
    let api = Repo {
        transport: &curl,
        name: c.repo.clone(),
    };
    let created = api.call(
        "POST",
        "/pulls",
        Some(&json!({ "title": title, "head": o.branch, "base": o.base_branch, "body": body, "draft": true })),
    )?;
    records.result("PR-CREATED.json", &created)?;
    let number = created["number"]
        .as_u64()
        .ok_or("the API returned no PR number; inspect PR-CREATED.json")?;
    // A fresh read of the PR, not the creation response, is what is checked and kept.
    let pr = api.call("GET", &format!("/pulls/{number}"), None)?;
    records.result("PR-READBACK.json", &pr)?;
    let reads = |pointer: &str, want: &Value| pr.pointer(pointer) == Some(want);
    if !(reads("/number", &json!(number))
        && reads("/state", &json!("open"))
        && reads("/base/repo/full_name", &json!(c.repo))
        && reads("/base/ref", &json!(o.base_branch))
        && reads("/head/ref", &json!(o.branch))
        && reads("/head/sha", &json!(head))
        && reads("/title", &json!(title))
        && reads("/body", &json!(body))
        && reads("/draft", &json!(true)))
    {
        return Err("the new PR does not read back as published; inspect PR-READBACK.json".into());
    }
    summary["pushed"] = json!(true);
    summary["pr"] = pr["number"].clone();
    summary["url"] = pr["html_url"].clone();
    Ok(summary)
}

fn mint_merge_main(o: &MintMergeMain) -> Result<serde_json::Value, String> {
    let name = short_name(&o.repo)?;
    let lists =
        Lists::load(&o.lists, &o.lists_sha256).map_err(|e| format!("namegate lists: {e:?}"))?;
    let git = Git::open(&o.git_dir)?;
    // Hold the parent before anything is minted, so a bad --out refuses first, and keep it: the
    // packet directory is made and written through this descriptor, never by path again.
    let parent_path = o
        .out
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(std::path::Path::new("."));
    let leaf = o
        .out
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("{}: --out must end in a plain name", o.out.display()))?;
    let parent = Held::open(parent_path)?;
    if parent.has(leaf)? {
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
    // If the parent's path now names another directory, refuse before making anything anywhere.
    if !Held::open(parent_path).is_ok_and(|now| parent.same_dir(&now).unwrap_or(false)) {
        return Err(format!(
            "{} no longer names the directory held for --out; nothing was written",
            parent_path.display()
        ));
    }
    let out = parent.create_dir_new(leaf)?;
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
    // A swap after the directory was made leaves the packet in the held parent, and whatever now
    // sits at --out untouched; report that rather than a packet at a path that is not it.
    if !Held::open(&o.out).is_ok_and(|now| out.same_dir(&now).unwrap_or(false)) {
        return Err(format!(
            "{} no longer names the packet just written in the held directory; inspect both",
            o.out.display()
        ));
    }
    let mut summary = summary;
    summary["packet"] = serde_json::json!(o.out);
    summary["seal"] = serde_json::json!(&sha256_hex(sums.as_bytes())[..8]);
    Ok(summary)
}
