//! `cargo commit-policy`: owner standing-policy checks for commits and pull requests.

use clap::{Parser, Subcommand};
use reverie_commit_policy::{
    AuthorList, Error, Staged, check_commit, dumps, dumps_fields, merge_decision, review_context,
    violations,
};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

#[derive(Parser)]
#[command(
    name = "cargo commit-policy",
    about = "Check commits and pull requests against an owner standing policy.",
    after_long_help = "OUTPUT:\n  check-commit, check-anonymity and merge-decision print one JSON object on stdout.\n  Exit 0 means allowed; 1 means refused (check-anonymity) or a policy or input error\n  (reported on stderr); 2 is a usage error. merge-decision only decides; it never merges."
)]
struct Arguments {
    /// The owner-controlled standing policy (JSON object).
    #[arg(long)]
    policy: PathBuf,
    /// Private author list (trailer keys and author patterns) for no_ai_coauthors; the policy's
    /// own values take precedence. Never part of a repository.
    #[arg(long, requires = "author_list_sha256", value_name = "FILE")]
    author_list: Option<PathBuf>,
    /// The author list's pinned SHA-256 (64 lowercase hex characters).
    #[arg(long, requires = "author_list", value_name = "HEX")]
    author_list_sha256: Option<String>,
    #[command(subcommand)]
    action: Action,
}

#[derive(Subcommand)]
enum Action {
    /// Admit the staged commit: anonymity, review receipt for the staged tree, message rules.
    CheckCommit {
        /// The repository whose index is checked.
        #[arg(long)]
        repo: PathBuf,
        /// Review receipt (JSON object).
        #[arg(long)]
        receipt: PathBuf,
        /// The commit message to check.
        #[arg(long)]
        message_file: Option<PathBuf>,
    },
    /// Print the review directives a reviewer must cover.
    ReviewContext {
        /// An additional project policy whose directives are appended.
        #[arg(long)]
        project_policy: Option<PathBuf>,
    },
    /// Scan a message or pull request text, and optionally a repository's staged diff, for agent names.
    CheckAnonymity {
        #[arg(long)]
        text_file: Option<PathBuf>,
        /// Repository whose staged diff is scanned.
        #[arg(long, value_name = "REPO")]
        staged: Option<PathBuf>,
    },
    /// Decide what to do with a pull request snapshot (JSON object) and its review receipt.
    MergeDecision {
        #[arg(long)]
        pr: PathBuf,
        #[arg(long)]
        receipt: PathBuf,
    },
}

fn main() -> ExitCode {
    let arguments = Arguments::parse();
    match run(&arguments) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("commit-policy: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: &Arguments) -> Result<ExitCode, Box<dyn std::error::Error>> {
    let mut policy = object(&arguments.policy, "standing policy")?;
    if let (Some(path), Some(pin)) = (&arguments.author_list, &arguments.author_list_sha256) {
        AuthorList::load(path, pin)?.apply(&mut policy)?;
    }
    match &arguments.action {
        Action::ReviewContext { project_policy } => {
            let project = project_policy
                .as_deref()
                .map(|path| object(path, "project policy"))
                .transpose()?;
            println!("{}", review_context(&policy, project.as_ref())?);
        }
        Action::CheckAnonymity { text_file, staged } => {
            let text = text_file
                .as_deref()
                .map(std::fs::read_to_string)
                .transpose()?;
            let diff = staged.as_deref().map(staged_diff).transpose()?;
            let found = violations(&policy, text.as_deref(), diff.as_deref())?;
            let rendered: Vec<String> = found
                .iter()
                .map(|v| {
                    dumps_fields(&[
                        ("where", json!(v.place)),
                        ("line", json!(v.line)),
                        ("name", json!(v.name)),
                    ])
                })
                .collect();
            println!(
                "{{\"allowed\": {}, \"violations\": [{}]}}",
                found.is_empty(),
                rendered.join(", ")
            );
            return Ok(if found.is_empty() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            });
        }
        Action::CheckCommit {
            repo,
            receipt,
            message_file,
        } => {
            let receipt = object(receipt, "review receipt")?;
            let message = message_file
                .as_deref()
                .map(std::fs::read_to_string)
                .transpose()?;
            let tree = git(repo, &["write-tree"])?.trim().to_owned();
            let diff = staged_diff(repo)?;
            let author = std::env::var("REVERIE_AGENT_ID")
                .ok()
                .filter(|id| !id.is_empty())
                .unwrap_or_else(|| "implementer".into());
            let staged = Staged {
                tree: &tree,
                diff: &diff,
                author: &author,
            };
            let tree = check_commit(&policy, &receipt, message.as_deref(), &staged)?;
            println!(
                "{}",
                dumps_fields(&[("allowed", json!(true)), ("tree", json!(tree))])
            );
        }
        Action::MergeDecision { pr, receipt } => {
            let snapshot = object(pr, "pull request snapshot")?;
            let receipt = object(receipt, "review receipt")?;
            let decision = merge_decision(&snapshot, &receipt, &policy)?;
            println!("{}", dumps_fields(&decision.fields()));
        }
    }
    Ok(ExitCode::SUCCESS)
}

/// A JSON object from a file; `~/` expands to the home directory.
fn object(path: &Path, what: &str) -> Result<Map<String, Value>, Box<dyn std::error::Error>> {
    let path = match (path.strip_prefix("~"), std::env::var_os("HOME")) {
        (Ok(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => path.to_path_buf(),
    };
    match serde_json::from_str(&std::fs::read_to_string(&path)?)? {
        Value::Object(map) => Ok(map),
        other => Err(Error::Malformed(format!(
            "{what} must be an object, not {}",
            dumps(&kind(&other))
        ))
        .into()),
    }
}

fn kind(value: &Value) -> Value {
    json!(match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "list",
        Value::Object(_) => "object",
    })
}

fn staged_diff(repo: &Path) -> Result<String, Box<dyn std::error::Error>> {
    git(
        repo,
        &[
            "diff",
            "--cached",
            "-U0",
            "--no-color",
            "--no-ext-diff",
            "--no-renames",
            "--src-prefix=a/",
            "--dst-prefix=b/",
        ],
    )
}

fn git(repo: &Path, arguments: &[&str]) -> Result<String, Box<dyn std::error::Error>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(arguments)
        .output()?;
    if !output.status.success() {
        return Err(format!("git {} failed: {}", arguments[0], output.status).into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
