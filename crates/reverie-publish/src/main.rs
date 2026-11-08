//! `reverie-publish`: reviewed publication from sealed packets. `check` runs every shared check
//! and writes only into the local object store it is given (the imported objects and refs,
//! through a private bundle copy it removes); `new-pr` pushes a reviewed head to a new branch and
//! opens a draft PR; `push-ff` fast-forwards an existing PR's head branch to a reviewed head.
use clap::{Parser, Subcommand};
use reverie_namegate::Lists;
use reverie_publish::{
    askpass,
    git::Git,
    github::{API, Curl, Repo},
    pull::Target,
    record::Records,
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
    /// Fast-forward a PR's head branch from --old to the reviewed head, after every check and the
    /// approval record pass. The PR must be open with its head at --old, in the base repository
    /// or in a fork that allows maintainer pushes. A sealed title and body are set and read back.
    PushFf(PushFf),
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

fn main() -> ExitCode {
    if std::env::var_os(askpass::MODE).is_some_and(|mode| mode == "1") {
        return ask();
    }
    let result = match Arguments::parse().action {
        Action::Check(options) => check(&options),
        Action::NewPr(options) => new_pr(&options),
        Action::PushFf(options) => push_ff(&options),
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
