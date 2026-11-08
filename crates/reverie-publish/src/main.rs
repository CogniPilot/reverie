//! `reverie-publish`: reviewed publication from sealed packets. `check` runs every shared check
//! against a packet and an object store, and writes only the imported objects into that local store
//! (through a private bundle copy it removes; refs stay in a private git directory). `new-pr`
//! pushes a reviewed head to a new branch and opens a draft PR; `push-ff` fast-forwards an existing
//! PR's head branch to a reviewed head. `pr-text`, `issue-create` and `issue-close` publish text
//! only (a PR's title, body and labels, an issue, a closing comment), each from a sealed packet and
//! a text approval record. `mint-merge-main` makes and checks the merge of main into a PR head in a
//! local store and writes a new sealed packet for review. `merge` runs the same checks, then
//! GitHub's, and merges the PR with a merge commit.
use clap::{Parser, Subcommand};
use reverie_namegate::{Kind, Lists};
use reverie_publish::{
    approval::Approval,
    askpass, commits,
    custody::Held,
    git::Git,
    github::{API, Curl, Repo},
    merge, mint,
    packet::Packet,
    pull::Target,
    record::Records,
    sha256_hex, short_name,
    text::{TextApproval, Texts, Write},
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
    /// Set a PR's title, body and labels from a packet, after the text approval passes and while
    /// the PR is open at --head; each is read back.
    PrText(PrText),
    /// Open an issue with the packet's title, body and labels, unless an open issue already has
    /// that title; it is read back.
    IssueCreate(TextArgs),
    /// Comment the packet's COMMENT.md on an open issue or PR and close it (a PR is closed
    /// unmerged, and must still be at --head); the saved comment is read back by its id, and the
    /// issue or PR by its number.
    IssueClose(IssueClose),
    /// Fast-forward a PR's head branch from --old to the reviewed head, after every check and the
    /// approval record pass. The PR must be open with its head at --old, in the base repository
    /// or in a fork that allows maintainer pushes. A sealed title and body are set and read back.
    PushFf(PushFf),
    /// Merge main into a PR head in the local object store: PR head first, main second, one
    /// identity with its sign-off, the tree `git merge-tree` computes, and a delta over the head
    /// that is exactly main's own change. Writes a new sealed packet (bundle, commit, deltas,
    /// remerge diff, summary) for review. Nothing is pushed or sent.
    MintMergeMain(MintMergeMain),
    /// Merge a PR with a merge commit after every check passes: the packet checks above with an
    /// approval record that names this PR, then GitHub's: the PR is open at --head with the
    /// reviewed title and body and reported clean, every check run on that head passed, and its
    /// title, body, comments and reviews pass rule 8. Records the intent first and reads the
    /// merge back.
    Merge(Merge),
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

/// What every text write takes.
#[derive(clap::Args)]
struct TextArgs {
    /// The sealed packet directory; its path must not pass through a symlink.
    #[arg(long)]
    packet: PathBuf,
    /// The packet's seal: leading hex digits of sha256(SHA256SUMS), at least 8.
    #[arg(long)]
    seal: String,
    /// The target repository, OWNER/NAME.
    #[arg(long)]
    repo: String,
    /// The private namegate list file and its pinned sha256.
    #[arg(long)]
    lists: PathBuf,
    #[arg(long)]
    lists_sha256: String,
    /// The text approval record that authorizes this write.
    #[arg(long)]
    approval: PathBuf,
    /// Directory for the intent, result and readback records.
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

#[derive(clap::Args)]
struct PrText {
    #[command(flatten)]
    text: TextArgs,
    /// The PR number.
    #[arg(long)]
    pr: u64,
    /// The PR's head (full id); the PR must still be at it.
    #[arg(long)]
    head: String,
}

#[derive(clap::Args)]
struct IssueClose {
    #[command(flatten)]
    text: TextArgs,
    /// The issue or PR number.
    #[arg(long)]
    number: u64,
    /// For a PR, its head (full id); the PR must still be at it. Not given for an issue.
    #[arg(long)]
    head: Option<String>,
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

#[derive(clap::Args)]
struct PushFf {
    #[command(flatten)]
    common: Common,
    /// The approval record that authorizes this publication.
    #[arg(long)]
    approval: PathBuf,
    /// The PR number.
    #[arg(long)]
    pr: u64,
    /// The PR's current head (full id): the PR and its branch must still point here.
    #[arg(long)]
    old: String,
    /// Where to push; defaults to https://github.com/<the PR's head repository>.git, the base
    /// repository or the fork its maintainers may push to. Only that URL is ever given the token;
    /// a local path or file:// URL (for tests) is pushed without it, and any other URL refuses.
    #[arg(long)]
    remote_url: Option<String>,
    /// Where to fetch the PR's base branch; defaults to https://github.com/OWNER/NAME.git. The same
    /// rule applies, though a fetch never carries the token.
    #[arg(long)]
    base_url: Option<String>,
    /// Directory for the intent, push result and PR readback records.
    #[arg(long)]
    records: PathBuf,
    /// The file holding only the token.
    #[arg(long)]
    token_file: PathBuf,
    /// The GitHub API base (a loopback test server is the only alternative).
    #[arg(long, default_value = API)]
    api_base: String,
    /// After the push, also record the first CI runs for the new head (CI-FIRST-READBACK.json).
    #[arg(long)]
    ci_readback: bool,
    /// Run every check and stop before writing.
    #[arg(long)]
    dry: bool,
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

fn main() -> ExitCode {
    if std::env::var_os(askpass::MODE).is_some_and(|mode| mode == "1") {
        return ask();
    }
    let result = match Arguments::parse().action {
        Action::Check(options) => check(&options),
        Action::NewPr(options) => new_pr(&options),
        Action::PrText(options) => pr_text(&options),
        Action::IssueCreate(options) => issue_create(&options),
        Action::IssueClose(options) => issue_close(&options),
        Action::PushFf(options) => push_ff(&options),
        Action::MintMergeMain(options) => mint_merge_main(&options),
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

/// Where to fetch and push for `flag`, and whether the token may be used there: only `repo`'s
/// GitHub URL is given credentials. A local path or file:// URL is accepted without them; any other
/// URL is refused, so the token never goes to an unapproved destination.
fn remote(flag: &str, remote_url: Option<&str>, repo: &str) -> Result<(String, bool), String> {
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
            "{flag} {url} is neither {approved} nor a local path; the token is never sent elsewhere"
        )),
    }
}

fn new_pr(o: &NewPr) -> Result<Value, String> {
    let c = &o.common;
    let git = Git::open(&c.git_dir)?;
    let lists = lists(c)?;
    let (url, credentials) = remote("--remote-url", o.remote_url.as_deref(), &c.repo)?;
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

/// A text write that passed its checks: the packet's texts, an API client and the records place.
struct Prepared {
    texts: Texts,
    curl: Curl,
}

/// Opens the packet, reads and scans its texts, checks the token file and the API base, and
/// verifies the approval for `action` on `number` at `head`.
fn prepare(
    o: &TextArgs,
    action: &str,
    number: Option<u64>,
    head: Option<&str>,
) -> Result<Prepared, String> {
    let name = short_name(&o.repo)?;
    let lists =
        Lists::load(&o.lists, &o.lists_sha256).map_err(|e| format!("namegate lists: {e:?}"))?;
    let texts = Texts::from_packet(&Packet::open(&o.packet, &o.seal)?)?;
    texts.scan(&lists, name)?;
    TextApproval::load(&o.approval)?.verify(&Write {
        repo: &o.repo,
        action,
        number,
        head,
        texts: &texts,
    })?;
    let curl = Curl::new(&o.token_file, &o.records, &o.api_base)?;
    let token =
        std::fs::read_to_string(&o.token_file).map_err(|e| format!("token file: {}", e.kind()))?;
    if token.trim().is_empty() || token.trim().contains(char::is_whitespace) {
        return Err("the token file must hold one token".into());
    }
    Ok(Prepared { texts, curl })
}

fn full_id(id: &str, what: &str) -> Result<(), String> {
    if id.len() == 40 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("{what} must be a full commit id"))
    }
}

fn str_at<'v>(value: &'v Value, pointer: &str) -> Option<&'v str> {
    value.pointer(pointer).and_then(Value::as_str)
}

/// The label names on an issue or PR object, sorted.
fn label_names(value: &Value) -> Vec<String> {
    let mut names: Vec<String> = value["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|label| label["name"].as_str().map(str::to_owned))
        .collect();
    names.sort();
    names
}

fn same_labels(value: &Value, want: &[String]) -> bool {
    let mut want = want.to_vec();
    want.sort();
    label_names(value) == want
}

/// Checks that an issue or PR read for `number` names that number: the path asked for is not
/// evidence of what came back.
fn same_number(value: &Value, number: u64, what: &str) -> Result<(), String> {
    match value["number"].as_u64() {
        Some(n) if n == number => Ok(()),
        Some(n) => Err(format!("{what} {number} reads back as number {n}")),
        None => Err(format!("{what} {number} reads back with no number")),
    }
}

/// Checks that `pr` is PR `number`, open and unmerged, at `head`.
fn check_open_pr(pr: &Value, number: u64, head: &str) -> Result<(), String> {
    same_number(pr, number, "PR")?;
    if str_at(pr, "/state") != Some("open") || pr["merged"] == json!(true) {
        return Err(format!("PR {number} is not open"));
    }
    if str_at(pr, "/head/sha") != Some(head) {
        return Err(format!("PR {number} is not at --head: it moved"));
    }
    Ok(())
}

/// Checks that the PR is open at `head`; returns it.
fn open_pr_at(api: &Repo<'_>, number: u64, head: &str) -> Result<Value, String> {
    let pr = api.call("GET", &format!("/pulls/{number}"), None)?;
    check_open_pr(&pr, number, head)?;
    Ok(pr)
}

fn pr_text(o: &PrText) -> Result<Value, String> {
    full_id(&o.head, "--head")?;
    let Prepared { texts, curl } = prepare(&o.text, "pr-text", Some(o.pr), Some(&o.head))?;
    if texts.comment.is_some() {
        return Err("pr-text publishes no comment; COMMENT.md belongs to issue-close".into());
    }
    if texts.title.is_none() && texts.body.is_none() && texts.labels.is_none() {
        return Err("the packet has no title, body or labels to set".into());
    }
    let api = Repo {
        transport: &curl,
        name: o.text.repo.clone(),
    };
    open_pr_at(&api, o.pr, &o.head)?;
    let mut summary = json!({
        "verified": true,
        "action": "pr-text",
        "pr": o.pr,
        "head": o.head,
        "title": texts.title,
        "bodySha256": texts.body.as_deref().map(|b| sha256_hex(b.as_bytes())),
        "labels": texts.labels.as_ref().map(|(names, _)| names),
    });
    if o.text.dry {
        return Ok(summary);
    }
    let records = Records::new(&o.text.records)?;
    records.intent(&json!({
        "action": "pr-text",
        "repo": o.text.repo,
        "pr": o.pr,
        "head": o.head,
        "packetSeal": o.text.seal,
        "approval": o.text.approval,
    }))?;
    let mut patch = serde_json::Map::new();
    if let Some(title) = &texts.title {
        patch.insert("title".into(), json!(title));
    }
    if let Some(body) = &texts.body {
        patch.insert("body".into(), json!(body));
    }
    if !patch.is_empty() {
        let result = api.call(
            "PATCH",
            &format!("/pulls/{}", o.pr),
            Some(&Value::Object(patch)),
        )?;
        records.result("PR-TEXT-RESULT.json", &result)?;
    }
    if let Some((names, _)) = &texts.labels {
        let result = api.call(
            "PUT",
            &format!("/issues/{}/labels", o.pr),
            Some(&json!({ "labels": names })),
        )?;
        records.result("LABELS-RESULT.json", &result)?;
    }
    let pr = api.call("GET", &format!("/pulls/{}", o.pr), None)?;
    records.result("PR-READBACK.json", &pr)?;
    check_open_pr(&pr, o.pr, &o.head).map_err(|e| format!("{e}; inspect PR-READBACK.json"))?;
    let reads = |pointer: &str, want: &Option<String>| {
        want.as_deref()
            .is_none_or(|want| str_at(&pr, pointer) == Some(want))
    };
    let labels_ok = texts
        .labels
        .as_ref()
        .is_none_or(|(names, _)| same_labels(&pr, names));
    if !(reads("/title", &texts.title) && reads("/body", &texts.body) && labels_ok) {
        return Err("the PR does not read back as published; inspect PR-READBACK.json".into());
    }
    summary["published"] = json!(true);
    Ok(summary)
}

fn issue_create(o: &TextArgs) -> Result<Value, String> {
    let Prepared { texts, curl } = prepare(o, "issue-create", None, None)?;
    let (Some(title), Some(body), None) = (&texts.title, &texts.body, &texts.comment) else {
        return Err("a new issue needs a title and a body, and no COMMENT.md".into());
    };
    let api = Repo {
        transport: &curl,
        name: o.repo.clone(),
    };
    let open = api.call("GET", "/issues?state=open&per_page=100", None)?;
    let open = open.as_array().ok_or("the open-issue list is not a list")?;
    if open.len() >= 100 {
        return Err("100 or more open issues: too many to rule out a duplicate title".into());
    }
    if open
        .iter()
        .any(|issue| issue.get("pull_request").is_none() && str_at(issue, "/title") == Some(title))
    {
        return Err("an open issue already has this title; inspect it before any retry".into());
    }
    let labels = texts.labels.as_ref().map(|(names, _)| names.clone());
    let mut summary = json!({
        "verified": true,
        "action": "issue-create",
        "title": title,
        "bodySha256": sha256_hex(body.as_bytes()),
        "labels": labels,
    });
    if o.dry {
        return Ok(summary);
    }
    let records = Records::new(&o.records)?;
    let mut request = json!({ "title": title, "body": body });
    if let Some(labels) = &labels {
        request["labels"] = json!(labels);
    }
    records.intent(&json!({
        "action": "issue-create",
        "repo": o.repo,
        "request": request,
        "packetSeal": o.seal,
        "approval": o.approval,
    }))?;
    let created = api.call("POST", "/issues", Some(&request))?;
    records.result("ISSUE-RESULT.json", &created)?;
    let number = created["number"]
        .as_u64()
        .ok_or("the new issue has no number")?;
    let issue = api.call("GET", &format!("/issues/{number}"), None)?;
    records.result("ISSUE-READBACK.json", &issue)?;
    same_number(&issue, number, "the new issue")
        .map_err(|e| format!("{e}; inspect ISSUE-READBACK.json"))?;
    if issue.get("pull_request").is_some() {
        return Err("the new issue reads back as a PR; inspect ISSUE-READBACK.json".into());
    }
    let labels_ok = labels
        .as_ref()
        .is_none_or(|names| same_labels(&issue, names));
    if !(str_at(&issue, "/state") == Some("open")
        && str_at(&issue, "/title") == Some(title)
        && str_at(&issue, "/body") == Some(body)
        && labels_ok)
    {
        return Err(
            "the issue does not read back as published; inspect ISSUE-READBACK.json".into(),
        );
    }
    summary["published"] = json!(true);
    summary["number"] = json!(number);
    summary["url"] = issue["html_url"].clone();
    Ok(summary)
}

/// For `issue-close`: the issue, and the PR when the number is one (open, unmerged, at --head).
fn close_target(api: &Repo<'_>, o: &IssueClose) -> Result<Option<String>, String> {
    let issue = api.call("GET", &format!("/issues/{}", o.number), None)?;
    same_number(&issue, o.number, "issue")?;
    if str_at(&issue, "/state") != Some("open") {
        return Err(format!("{} is not open", o.number));
    }
    match (issue.get("pull_request").is_some(), &o.head) {
        (true, Some(head)) => {
            open_pr_at(api, o.number, head)?;
            Ok(Some(head.clone()))
        }
        (true, None) => Err(format!("{} is a PR: --head is required", o.number)),
        (false, Some(_)) => Err(format!("{} is an issue: --head is only for a PR", o.number)),
        (false, None) => Ok(None),
    }
}

fn issue_close(o: &IssueClose) -> Result<Value, String> {
    if let Some(head) = &o.head {
        full_id(head, "--head")?;
    }
    let Prepared { texts, curl } =
        prepare(&o.text, "issue-close", Some(o.number), o.head.as_deref())?;
    let (Some(comment), None, None, None) =
        (&texts.comment, &texts.title, &texts.body, &texts.labels)
    else {
        return Err("closing takes only COMMENT.md from the packet".into());
    };
    let api = Repo {
        transport: &curl,
        name: o.text.repo.clone(),
    };
    let head = close_target(&api, o)?;
    let comments = api.call(
        "GET",
        &format!("/issues/{}/comments?per_page=100", o.number),
        None,
    )?;
    let comments = comments
        .as_array()
        .ok_or("the comment list is not a list")?;
    if comments.len() >= 100 {
        return Err("100 or more comments: too many to rule out a duplicate".into());
    }
    if comments.iter().any(|c| str_at(c, "/body") == Some(comment)) {
        return Err("this exact comment is already there; inspect it before any retry".into());
    }
    let mut summary = json!({
        "verified": true,
        "action": "issue-close",
        "number": o.number,
        "pr": head.is_some(),
        "commentSha256": sha256_hex(comment.as_bytes()),
    });
    if o.text.dry {
        return Ok(summary);
    }
    let records = Records::new(&o.text.records)?;
    records.intent(&json!({
        "action": "issue-close",
        "repo": o.text.repo,
        "number": o.number,
        "head": head,
        "commentSha256": sha256_hex(comment.as_bytes()),
        "packetSeal": o.text.seal,
        "approval": o.text.approval,
    }))?;
    let posted = api.call(
        "POST",
        &format!("/issues/{}/comments", o.number),
        Some(&json!({ "body": comment })),
    )?;
    records.result("COMMENT-RESULT.json", &posted)?;
    // The POST's echo is not what GitHub kept: read the saved comment back by its id, and check
    // it is this text on this issue before closing. An uncertain comment is never posted again.
    let id = posted["id"]
        .as_u64()
        .ok_or("the posted comment has no id; inspect COMMENT-RESULT.json")?;
    let saved = api.call("GET", &format!("/issues/comments/{id}"), None)?;
    records.result("COMMENT-READBACK.json", &saved)?;
    let target = format!("/repos/{}/issues/{}", o.text.repo, o.number);
    if saved["id"].as_u64() != Some(id)
        || str_at(&saved, "/body") != Some(comment)
        || !str_at(&saved, "/issue_url").is_some_and(|url| url.ends_with(&target))
    {
        return Err(
            "the saved comment is not this text on this issue; inspect COMMENT-READBACK.json"
                .into(),
        );
    }
    if let Some(head) = &head {
        open_pr_at(&api, o.number, head)?;
    }
    let closed = api.call(
        "PATCH",
        &format!("/issues/{}", o.number),
        Some(&json!({ "state": "closed" })),
    )?;
    records.result("CLOSE-RESULT.json", &closed)?;
    let issue = api.call("GET", &format!("/issues/{}", o.number), None)?;
    records.result("CLOSE-READBACK.json", &issue)?;
    same_number(&issue, o.number, "issue")
        .map_err(|e| format!("{e}; inspect CLOSE-READBACK.json"))?;
    if str_at(&issue, "/state") != Some("closed") {
        return Err("it does not read back as closed; inspect CLOSE-READBACK.json".into());
    }
    if let Some(head) = &head {
        let pr = api.call("GET", &format!("/pulls/{}", o.number), None)?;
        records.result("PR-READBACK.json", &pr)?;
        same_number(&pr, o.number, "PR").map_err(|e| format!("{e}; inspect PR-READBACK.json"))?;
        if pr["merged"] != json!(false) || str_at(&pr, "/head/sha") != Some(head.as_str()) {
            return Err("the PR does not read back closed unmerged at --head".into());
        }
    }
    summary["published"] = json!(true);
    Ok(summary)
}

/// A fast-forward that passed every check, ready to push.
struct Ready {
    target: Target,
    url: String,
    /// Whether `url` is the PR head repository's GitHub URL, the only push given the token.
    credentials: bool,
    head: String,
    base: String,
    text: Option<(String, String)>,
    summary: Value,
}

fn token(token_file: &std::path::Path) -> Result<(), String> {
    let token =
        std::fs::read_to_string(token_file).map_err(|e| format!("token file: {}", e.kind()))?;
    askpass::token(&token).map(drop)
}

fn prepare_ff(o: &PushFf, git: &Git, api: &Repo<'_>) -> Result<Ready, String> {
    let c = &o.common;
    if o.old.len() != 40 || !o.old.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("--old must be a full commit id".into());
    }
    let target = Target::from_pr(
        &api.call("GET", &format!("/pulls/{}", o.pr), None)?,
        &c.repo,
        &o.old,
    )?;
    // The push goes only to the repository the PR itself names as its head.
    let (url, credentials) = remote("--remote-url", o.remote_url.as_deref(), &target.repo)?;
    let (base_url, _) = remote("--base-url", o.base_url.as_deref(), &c.repo)?;
    let base = git.fetch_branch(&base_url, &target.base, "base")?;
    if git.fetch_branch(&url, &target.branch, "remote")? != o.old {
        return Err(format!(
            "branch {} is not at --old: it moved",
            target.branch
        ));
    }
    let verified = run_verify(c, git, &lists(c)?, &base, Some(&o.approval))?;
    let head = verified.head.clone();
    if head == o.old || !git.succeeds(["merge-base", "--is-ancestor", &o.old, &head])? {
        return Err("the head is not a fast-forward of --old".into());
    }
    let mut summary = verified.summary;
    summary["pr"] = json!(o.pr);
    summary["old"] = json!(o.old);
    summary["headRepo"] = json!(target.repo);
    summary["branch"] = json!(target.branch);
    summary["fork"] = json!(target.fork);
    Ok(Ready {
        target,
        url,
        credentials,
        head,
        base,
        text: verified.text,
        summary,
    })
}

fn push_ff(o: &PushFf) -> Result<Value, String> {
    let c = &o.common;
    let git = Git::open(&c.git_dir)?;
    // Every input a write needs is validated before the first write.
    let curl = Curl::new(&o.token_file, &o.records, &o.api_base)?;
    token(&o.token_file)?;
    let api = Repo {
        transport: &curl,
        name: c.repo.clone(),
    };
    let ready = prepare_ff(o, &git, &api)?;
    if o.dry {
        return Ok(ready.summary);
    }
    let Ready {
        target,
        url,
        credentials,
        head,
        base,
        text,
        mut summary,
    } = ready;
    let reference = format!("refs/heads/{}", target.branch);
    let records = Records::new(&o.records)?;
    records.intent(&json!({
        "action": "push-ff",
        "repo": c.repo,
        "pr": o.pr,
        "headRepo": target.repo,
        "ref": reference,
        "old": o.old,
        "head": head,
        "base": base,
        "force": false,
        "text": text.is_some(),
        "packetSeal": c.seal,
        "approval": o.approval,
    }))?;
    let token_file = credentials.then_some(o.token_file.as_path());
    let (pushed, stderr) = git.push(&url, &format!("{head}:{reference}"), token_file)?;
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
    let path = format!("/pulls/{}", o.pr);
    if let Some((title, body)) = &text {
        let patched = api.call(
            "PATCH",
            &path,
            Some(&json!({ "title": title, "body": body })),
        )?;
        records.result("PR-TEXT-RESULT.json", &patched)?;
    }
    let pr = read_back(&api, &path, &head)?;
    records.result("PR-READBACK.json", &pr)?;
    let reads =
        |pointer: &str, want: &str| pr.pointer(pointer).and_then(Value::as_str) == Some(want);
    let text_ok = text
        .as_ref()
        .is_none_or(|(title, body)| reads("/title", title) && reads("/body", body));
    if !reads("/head/sha", &head) || !text_ok {
        return Err("the PR does not read back as published; inspect PR-READBACK.json".into());
    }
    if o.ci_readback {
        let runs = api.call(
            "GET",
            &format!("/actions/runs?head_sha={head}&per_page=10"),
            None,
        )?;
        records.result("CI-FIRST-READBACK.json", &runs)?;
        summary["ciRuns"] = runs["total_count"].clone();
    }
    summary["pushed"] = json!(true);
    summary["url"] = pr["html_url"].clone();
    Ok(summary)
}

/// The PR as GitHub reports it once its head is `head`. GitHub can take a moment to move a PR's
/// head after a push, so this asks up to five times, two seconds apart, and returns the last
/// answer either way.
fn read_back(api: &Repo<'_>, path: &str, head: &str) -> Result<Value, String> {
    let mut pr = api.call("GET", path, None)?;
    for _ in 0..4 {
        if pr.pointer("/head/sha").and_then(Value::as_str) == Some(head) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
        pr = api.call("GET", path, None)?;
    }
    Ok(pr)
}

/// A packet's title and body.
type PacketText = (String, String);

/// Every packet check, then `approval` (already loaded, never read again) against the exact head,
/// base, title and body those checks verified; returns the summary and the packet's title and body.
fn verify_approved(o: &Check, approval: &Approval) -> Result<(Value, Option<PacketText>), String> {
    let git = Git::open(&o.common.git_dir)?;
    let verified = run_verify(&o.common, &git, &lists(&o.common)?, &o.base, None)?;
    let text = verified
        .text
        .as_ref()
        .map(|(t, b)| (t.as_str(), b.as_str()));
    approval.verify(&git, &o.common.repo, &verified.head, &verified.base, text)?;
    let mut summary = verified.summary;
    summary["approval"] = json!(true);
    Ok((summary, verified.text))
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
    let branch = approval
        .merge_base_branch
        .as_deref()
        .ok_or("the approval record does not name the branch the merge targets")?;
    // Every packet check, the approval against the exact head, base, title and body included.
    let (mut summary, text) = verify_approved(&o.check, &approval)?;
    let (title, body) =
        text.ok_or("merging needs the reviewed TITLE.txt and BODY.md in the packet")?;
    let name = short_name(&o.check.common.repo)?;
    let lists = lists(&o.check.common)?;
    let curl = Curl::new(&o.token_file, &o.scratch, &o.api_base)?;
    let api = Repo {
        transport: &curl,
        name: o.check.common.repo.clone(),
    };
    let (number, head) = (o.pr, o.check.common.head.as_str());
    let pr = api.call("GET", &format!("/pulls/{number}"), None)?;
    merge::ready(&pr, number, head, &title, &body)?;
    // approval.verify above has bound approval.base to the full id of --base in the store.
    let target = merge::Target {
        repo: &o.check.common.repo,
        branch,
        base: &approval.base,
    };
    merge::targets(&pr, target)?;
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
        "repo": o.check.common.repo,
        "pr": number,
        "head": head,
        "baseBranch": branch,
        "base": approval.base,
        "mergeMethod": "merge",
        "packetSeal": o.check.common.seal,
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
    merge::merged(&after, &commit, number, head, &sha, target)?;
    summary["merged"] = json!(true);
    summary["mergeCommit"] = json!(sha);
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::remote;

    #[test]
    fn only_the_named_repository_url_gets_the_token() {
        for repo in ["owner/demo", "zorblat/demo"] {
            let approved = format!("https://github.com/{repo}.git");
            assert_eq!(
                remote("--remote-url", None, repo),
                Ok((approved.clone(), true))
            );
            assert_eq!(
                remote("--remote-url", Some(&approved), repo),
                Ok((approved, true))
            );
        }
        // A fork's PR pushes to the fork; the base repository's URL is then another destination.
        assert!(
            remote(
                "--remote-url",
                Some("https://github.com/owner/demo.git"),
                "zorblat/demo"
            )
            .is_err()
        );
        assert_eq!(
            remote("--base-url", Some("/srv/remote.git"), "owner/demo"),
            Ok(("/srv/remote.git".to_owned(), false))
        );
        let refused = remote(
            "--base-url",
            Some("https://foreign.example.invalid/x.git"),
            "owner/demo",
        );
        assert!(refused.unwrap_err().starts_with("--base-url "));
    }
}
