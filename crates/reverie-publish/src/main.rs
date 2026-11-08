//! `reverie-publish`: reviewed publication from sealed packets. `check` runs every shared check
//! against a packet and an object store, and writes only into that local store (the imported
//! objects and refs, through a private bundle copy it removes). `pr-text`, `issue-create` and
//! `issue-close` publish text only (a PR's title, body and labels, an issue, a closing comment),
//! each from a sealed packet and a text approval record.
use clap::{Parser, Subcommand};
use reverie_namegate::{Kind, Lists};
use reverie_publish::{
    approval::Approval,
    commits,
    git::Git,
    github::{API, Curl, Repo},
    packet::Packet,
    record::Records,
    sha256_hex, short_name,
    text::{TextApproval, Texts, Write},
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
    /// Set a PR's title, body and labels from a packet, after the text approval passes and while
    /// the PR is open at --head; each is read back.
    PrText(PrText),
    /// Open an issue with the packet's title, body and labels, unless an open issue already has
    /// that title; it is read back.
    IssueCreate(TextArgs),
    /// Comment the packet's COMMENT.md on an open issue or PR and close it (a PR is closed
    /// unmerged, and must still be at --head); both are read back.
    IssueClose(IssueClose),
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
        Action::PrText(options) => pr_text(&options),
        Action::IssueCreate(options) => issue_create(&options),
        Action::IssueClose(options) => issue_close(&options),
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
    let base = git.run([
        "rev-parse",
        "--verify",
        "--end-of-options",
        &format!("{}^{{commit}}", o.base),
    ])?;
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

/// Checks that the PR is open at `head`; returns it.
fn open_pr_at(api: &Repo<'_>, number: u64, head: &str) -> Result<Value, String> {
    let pr = api.call("GET", &format!("/pulls/{number}"), None)?;
    if str_at(&pr, "/state") != Some("open") || pr["merged"] == json!(true) {
        return Err(format!("PR {number} is not open"));
    }
    if str_at(&pr, "/head/sha") != Some(head) {
        return Err(format!("PR {number} is not at --head: it moved"));
    }
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
    let pr = open_pr_at(&api, o.pr, &o.head)?;
    records.result("PR-READBACK.json", &pr)?;
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
    if str_at(&posted, "/body") != Some(comment) {
        return Err("the comment does not read back; inspect COMMENT-RESULT.json".into());
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
    if str_at(&issue, "/state") != Some("closed") {
        return Err("it does not read back as closed; inspect CLOSE-READBACK.json".into());
    }
    if let Some(head) = &head {
        let pr = api.call("GET", &format!("/pulls/{}", o.number), None)?;
        records.result("PR-READBACK.json", &pr)?;
        if pr["merged"] != json!(false) || str_at(&pr, "/head/sha") != Some(head.as_str()) {
            return Err("the PR does not read back closed unmerged at --head".into());
        }
    }
    summary["published"] = json!(true);
    Ok(summary)
}
