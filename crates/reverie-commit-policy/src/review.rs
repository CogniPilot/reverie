//! Review receipts, commit admission and the automatic-merge decision.

use crate::glob::fnmatchcase;
use crate::message::{commits, valid_message};
use crate::py::{eq, hashable, truthy};
use crate::{Error, anonymity, policy_error};
use serde_json::{Map, Value, json};

fn object<'a>(
    value: Option<&'a Value>,
    what: &str,
) -> Result<Option<&'a Map<String, Value>>, Error> {
    match value {
        None => Ok(None),
        Some(Value::Object(map)) => Ok(Some(map)),
        Some(_) => Err(Error::Malformed(format!("{what} must be an object"))),
    }
}

fn list<'a>(value: Option<&'a Value>, what: &str) -> Result<&'a [Value], Error> {
    match value {
        None => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(Error::Malformed(format!("{what} must be a list"))),
    }
}

fn strings<'a>(value: Option<&'a Value>, what: &str) -> Result<Vec<&'a str>, Error> {
    list(value, what)?
        .iter()
        .map(|item| {
            item.as_str()
                .ok_or_else(|| Error::Malformed(format!("{what} must be strings")))
        })
        .collect()
}

/// Members of a Python set built from `items`; lists and objects cannot be members.
fn members<'a>(items: &'a [Value], what: &str) -> Result<&'a [Value], Error> {
    if items.iter().all(hashable) {
        Ok(items)
    } else {
        Err(Error::Malformed(format!("{what} must hold plain values")))
    }
}

/// `set(left) - set(right)` is non-empty.
fn missing(left: &[Value], right: &[Value]) -> bool {
    left.iter()
        .any(|item| !right.iter().any(|other| eq(item, other)))
}

/// The ids of the policy's `review_directives`.
///
/// # Errors
/// [`Error::Malformed`] when a directive is not an object with an `id`.
pub fn directive_ids(policy: &Map<String, Value>) -> Result<Vec<Value>, Error> {
    list(policy.get("review_directives"), "review_directives")?
        .iter()
        .map(|rule| {
            rule.get("id")
                .cloned()
                .ok_or_else(|| Error::Malformed("every review directive needs an id".into()))
        })
        .collect()
}

/// A directive's string field; the reference concatenates it, so anything else is unusable.
fn field<'a>(rule: &'a Value, name: &str) -> Result<&'a str, Error> {
    rule.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Malformed(format!("review directive {name} must be a string")))
}

/// Required review instructions from the standing policy and an optional project policy.
///
/// # Errors
/// [`Error::Malformed`] when a directive lacks a string `id` or `instruction`.
pub fn review_context(
    policy: &Map<String, Value>,
    project: Option<&Map<String, Value>>,
) -> Result<String, Error> {
    let empty = Map::new();
    let mut lines = vec!["Review directives:".to_owned()];
    for source in [policy, project.unwrap_or(&empty)] {
        for rule in list(source.get("review_directives"), "review_directives")? {
            let (id, instruction) = (field(rule, "id")?, field(rule, "instruction")?);
            lines.push(format!("- {id}: {instruction}"));
        }
    }
    let commits = commits(policy)?;
    if truthy(commits.get("require_review")) {
        lines.push("- Every commit needs review of its exact staged tree.".into());
    }
    if truthy(commits.get("dco_signoff")) {
        lines.push(
            "- Require DCO Signed-off-by trailers; this is distinct from cryptographic signing."
                .into(),
        );
    }
    if truthy(commits.get("no_ai_coauthors")) {
        lines.push("- Credit human contributors appropriately; no AI co-author trailers.".into());
    }
    Ok(lines.join("\n"))
}

/// Checks a review receipt against the revision it must cover.
///
/// # Errors
/// [`Error::Policy`] naming the first unmet condition; [`Error::Malformed`] for unusable input.
pub fn check_review(
    receipt: &Map<String, Value>,
    revision: &Value,
    author: &Value,
    directives: &[Value],
) -> Result<(), Error> {
    // A missing revision reads as `None`, which equals only a null revision.
    let covers = match receipt.get("revision") {
        Some(value) => eq(value, revision),
        None => revision.is_null(),
    };
    if !covers {
        return Err(policy_error("review does not match the current revision"));
    }
    if receipt.get("approved") != Some(&Value::Bool(true))
        || truthy(receipt.get("unresolved_findings"))
    {
        return Err(policy_error(
            "review has unresolved findings or no approval",
        ));
    }
    if !truthy(receipt.get("reviewer")) || receipt.get("reviewer").is_some_and(|r| eq(r, author)) {
        return Err(policy_error("review must identify an independent reviewer"));
    }
    let covered = members(
        list(receipt.get("covered_directives"), "covered_directives")?,
        "covered_directives",
    )?;
    if missing(members(directives, "review directive ids")?, covered) {
        return Err(policy_error(
            "review did not address required design directives",
        ));
    }
    if !truthy(receipt.get("evidence")) {
        return Err(policy_error("review requires durable evidence"));
    }
    Ok(())
}

/// What a commit check needs from the repository, gathered by the caller.
#[derive(Debug)]
pub struct Staged<'a> {
    /// `git write-tree` of the index.
    pub tree: &'a str,
    /// `git diff --cached -U0` with `a/` and `b/` prefixes.
    pub diff: &'a str,
    /// The implementing agent, for the independent-reviewer rule.
    pub author: &'a str,
}

/// Admits a commit: anonymity over the message and staged diff, the review receipt against the
/// staged tree, then the message rules. Returns the admitted tree.
///
/// # Errors
/// [`Error::Policy`] for the first refusal; [`Error::Malformed`] for unusable input.
pub fn check_commit(
    policy: &Map<String, Value>,
    receipt: &Map<String, Value>,
    message: Option<&str>,
    staged: &Staged<'_>,
) -> Result<String, Error> {
    if truthy(policy.get("agent_anonymity")) {
        anonymity::check(policy, message, Some(staged.diff))?;
    }
    if truthy(commits(policy)?.get("require_review")) {
        check_review(
            receipt,
            &json!(staged.tree),
            &json!(staged.author),
            &directive_ids(policy)?,
        )?;
    }
    if let Some(message) = message {
        valid_message(message, policy)?;
    }
    Ok(staged.tree.to_owned())
}

/// A merge decision. `head_sha` and `method` are set only for `auto_merge`.
#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    /// `wait`, `owner_review`, `adversarial_review` or `auto_merge`.
    pub action: String,
    /// Why, in the reference wording.
    pub reason: String,
    /// The reviewed head the merge is pinned to.
    pub head_sha: Option<Value>,
    /// The repository's merge method (default `rebase`).
    pub method: Option<Value>,
}

impl Decision {
    /// The reference output fields in order: `action`, `reason`, then `head_sha`, `method`.
    #[must_use]
    pub fn fields(&self) -> Vec<(&'static str, Value)> {
        let mut fields = vec![
            ("action", json!(self.action)),
            ("reason", json!(self.reason)),
        ];
        if let (Some(head), Some(method)) = (&self.head_sha, &self.method) {
            fields.push(("head_sha", head.clone()));
            fields.push(("method", method.clone()));
        }
        fields
    }
}

fn decision(action: &str, reason: &str) -> Decision {
    Decision {
        action: action.to_owned(),
        reason: reason.to_owned(),
        head_sha: None,
        method: None,
    }
}

/// Decides what to do with a pull request snapshot: wait, owner review, adversarial review, or
/// an automatic merge pinned to the reviewed head.
///
/// # Errors
/// [`Error::Malformed`] for unusable input (the reference fails on the same shapes).
pub fn merge_decision(
    pr: &Map<String, Value>,
    review: &Map<String, Value>,
    policy: &Map<String, Value>,
) -> Result<Decision, Error> {
    let empty = Map::new();
    let repositories = object(policy.get("repositories"), "repositories")?.unwrap_or(&empty);
    let repo = match pr.get("repository") {
        Some(Value::String(name)) => object(repositories.get(name), "repository policy")?,
        _ => None,
    }
    .unwrap_or(&empty);
    if !repo
        .get("auto_merge")
        .is_some_and(|value| truthy(Some(value)))
    {
        return Ok(decision(
            "owner_review",
            "automatic merging is not enabled for this repository",
        ));
    }
    if truthy(pr.get("draft")) || pr.get("mergeable") != Some(&json!("MERGEABLE")) {
        return Ok(decision(
            "wait",
            "PR is draft, conflicting or not yet known mergeable",
        ));
    }
    let owner_paths = strings(repo.get("owner_review_paths"), "owner_review_paths")?;
    for path in strings(pr.get("files"), "files")? {
        if owner_paths.iter().any(|pattern| fnmatchcase(path, pattern)) {
            return Ok(decision(
                "owner_review",
                "change touches an owner-reviewed area",
            ));
        }
    }
    let labels = members(list(pr.get("labels"), "labels")?, "labels")?;
    let owner_labels = members(
        list(repo.get("owner_review_labels"), "owner_review_labels")?,
        "owner_review_labels",
    )?;
    if labels
        .iter()
        .any(|label| owner_labels.iter().any(|other| eq(label, other)))
    {
        return Ok(decision("owner_review", "PR carries an owner-review label"));
    }
    if !truthy(repo.get("required_checks")) {
        return Ok(decision(
            "owner_review",
            "required checks are not configured",
        ));
    }
    let empty_checks = Map::new();
    let checks = object(pr.get("checks"), "checks")?.unwrap_or(&empty_checks);
    let required = members(
        list(repo.get("required_checks"), "required_checks")?,
        "required_checks",
    )?;
    let passed = required.iter().all(|name| {
        name.as_str()
            .and_then(|name| checks.get(name))
            .is_some_and(|state| *state == "SUCCESS")
    });
    if !passed {
        return Ok(decision("wait", "required checks have not all passed"));
    }
    match admit(pr, review, policy) {
        Ok(()) => {}
        Err(Error::Policy(reason)) => return Ok(decision("adversarial_review", &reason)),
        Err(other) => return Err(other),
    }
    let head = pr
        .get("head_sha")
        .ok_or_else(|| Error::Malformed("head_sha is required".into()))?;
    let method = repo
        .get("merge_method")
        .cloned()
        .unwrap_or_else(|| json!("rebase"));
    Ok(Decision {
        head_sha: Some(head.clone()),
        method: Some(method),
        ..decision(
            "auto_merge",
            "current revision passed configured review and checks",
        )
    })
}

/// The review and commit-message part of a merge decision.
fn admit(
    pr: &Map<String, Value>,
    review: &Map<String, Value>,
    policy: &Map<String, Value>,
) -> Result<(), Error> {
    let head = pr
        .get("head_sha")
        .ok_or_else(|| Error::Malformed("head_sha is required".into()))?;
    let author = pr.get("author_agent").cloned().unwrap_or(Value::Null);
    check_review(review, head, &author, &directive_ids(policy)?)?;
    let reviewed = members(
        list(review.get("reviewed_files"), "reviewed_files")?,
        "reviewed_files",
    )?;
    let files = members(list(pr.get("files"), "files")?, "files")?;
    if missing(reviewed, files) || missing(files, reviewed) {
        return Err(policy_error("review does not cover every changed file"));
    }
    let messages = list(pr.get("commit_messages"), "commit_messages")?;
    if messages.is_empty() {
        return Err(policy_error("commit messages have not been checked"));
    }
    for message in messages {
        let text = message
            .as_str()
            .ok_or_else(|| Error::Malformed("commit messages must be strings".into()))?;
        valid_message(text, policy)?;
    }
    Ok(())
}
