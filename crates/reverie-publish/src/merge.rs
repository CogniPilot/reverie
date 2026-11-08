//! The guarded merge's GitHub-side checks, each a pure function of what GitHub returned, so it
//! can be tested on its own: the PR is the reviewed one and ready, every check on its exact head
//! passed, every public text on it can be scanned, and the merge reads back as a merge commit of
//! that head.
use serde_json::Value;

fn str_at<'v>(value: &'v Value, pointer: &str) -> Option<&'v str> {
    value.pointer(pointer).and_then(Value::as_str)
}

/// Checks that `pr` is PR `number`, open, unmerged and not a draft, at `head`, with exactly the
/// reviewed `title` and `body`, and that GitHub has found it mergeable with every requirement
/// met (`clean`: no conflict, required checks and reviews satisfied).
pub fn ready(pr: &Value, number: u64, head: &str, title: &str, body: &str) -> Result<(), String> {
    match pr["number"].as_u64() {
        Some(n) if n == number => {}
        Some(n) => return Err(format!("PR {number} reads back as number {n}")),
        None => return Err(format!("PR {number} reads back with no number")),
    }
    if str_at(pr, "/state") != Some("open") || pr["merged"] != Value::Bool(false) {
        return Err(format!("PR {number} is not open and unmerged"));
    }
    if pr["draft"] != Value::Bool(false) {
        return Err(format!("PR {number} is a draft"));
    }
    if str_at(pr, "/head/sha") != Some(head) {
        return Err(format!("PR {number} is not at --head: it moved"));
    }
    if str_at(pr, "/title") != Some(title) || str_at(pr, "/body").unwrap_or("") != body {
        return Err(format!(
            "PR {number}'s title or body is not the reviewed text"
        ));
    }
    if pr["mergeable"] != Value::Bool(true) {
        return Err(format!(
            "GitHub does not report PR {number} as mergeable (it may still be computing; try again)"
        ));
    }
    match str_at(pr, "/mergeable_state") {
        Some("clean") => Ok(()),
        state => Err(format!(
            "PR {number} is not ready to merge: mergeable_state is {}",
            state.unwrap_or("missing")
        )),
    }
}

/// Checks that `pr` targets the approved operation: a PR in `repo` onto `branch`, whose base is at
/// `base`. A retargeted PR, a base that moved since the review, or a missing field refuses.
pub fn targets(pr: &Value, repo: &str, branch: &str, base: &str) -> Result<(), String> {
    if str_at(pr, "/base/repo/full_name") != Some(repo) {
        return Err(format!("the PR's base is not in {repo}"));
    }
    match str_at(pr, "/base/ref") {
        Some(target) if target == branch => {}
        target => {
            return Err(format!(
                "the PR targets {}, not the approved branch {branch}",
                target.unwrap_or("no branch")
            ));
        }
    }
    if str_at(pr, "/base/sha") != Some(base) {
        return Err(format!(
            "the PR's base {branch} is not at the approved base: it moved, or the approval is for another base"
        ));
    }
    Ok(())
}

/// Checks that every check run on `head` completed as success, neutral or skipped (at least one,
/// and all of them on this one page), and that the commit's combined status is success or it has
/// no statuses at all. Returns the number of check runs.
pub fn checks_green(runs: &Value, status: &Value, head: &str) -> Result<usize, String> {
    let list = runs["check_runs"]
        .as_array()
        .ok_or("the check-run list is not a list")?;
    let total = runs["total_count"]
        .as_u64()
        .ok_or("the check runs have no total")?;
    if list.len() >= 100 || total != list.len() as u64 {
        return Err("too many check runs to read on one page; refusing rather than guess".into());
    }
    if list.is_empty() {
        return Err("no check run has run on the head".into());
    }
    for run in list {
        let name = str_at(run, "/name").unwrap_or("unnamed");
        if str_at(run, "/head_sha") != Some(head) {
            return Err(format!("check run {name} is for another commit"));
        }
        if str_at(run, "/status") != Some("completed") {
            return Err(format!("check run {name} has not completed"));
        }
        let conclusion = str_at(run, "/conclusion").unwrap_or("none");
        if !matches!(conclusion, "success" | "neutral" | "skipped") {
            return Err(format!("check run {name} concluded {conclusion}"));
        }
    }
    let statuses = status["total_count"]
        .as_u64()
        .ok_or("the commit status has no total")?;
    if statuses > 0 && str_at(status, "/state") != Some("success") {
        return Err(format!(
            "the head's combined status is {}",
            str_at(status, "/state").unwrap_or("missing")
        ));
    }
    Ok(list.len())
}

/// Every public text on the PR, labelled for a refusal: its title and body, and the body of each
/// comment, review and review comment. A list of 100 or more refuses rather than skip a page.
pub fn public_texts(
    pr: &Value,
    comments: &Value,
    reviews: &Value,
    review_comments: &Value,
) -> Result<Vec<(String, String)>, String> {
    let mut texts = vec![
        (
            "the PR title".to_owned(),
            str_at(pr, "/title").unwrap_or("").to_owned(),
        ),
        (
            "the PR body".to_owned(),
            str_at(pr, "/body").unwrap_or("").to_owned(),
        ),
    ];
    for (what, list) in [
        ("comment", comments),
        ("review", reviews),
        ("review comment", review_comments),
    ] {
        let list = list
            .as_array()
            .ok_or_else(|| format!("the {what} list is not a list"))?;
        if list.len() >= 100 {
            return Err(format!("100 or more {what}s: too many to scan on one page"));
        }
        for item in list {
            let id = item["id"].as_u64().map_or("?".into(), |id| id.to_string());
            let body = str_at(item, "/body").unwrap_or("").to_owned();
            texts.push((format!("{what} {id}"), body));
        }
    }
    Ok(texts)
}

/// A full lowercase commit id.
fn full_id(id: &str) -> bool {
    id.len() == 40 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The merge's own reply: GitHub must say it merged, with a full commit id. Returns that id.
pub fn merge_reply(result: &Value) -> Result<String, String> {
    let sha = str_at(result, "/sha").unwrap_or("");
    if result["merged"] != Value::Bool(true)
        || sha.len() != 40
        || !sha.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("GitHub did not report a merge; inspect MERGE-RESULT.json".into());
    }
    Ok(sha.to_owned())
}

/// The readback: PR `number` is merged at `head` with `sha` as its merge commit, and that commit
/// is a merge commit, two parents, the second being `head` (not a squash or a rebase) and the first
/// being the approved `base`. GitHub's merge is conditioned on the head only, so a base that moved
/// between the checks and the merge shows here, after the fact.
pub fn merged(
    pr: &Value,
    commit: &Value,
    number: u64,
    head: &str,
    sha: &str,
    base: &str,
) -> Result<(), String> {
    if pr["number"].as_u64() != Some(number)
        || pr["merged"] != Value::Bool(true)
        || str_at(pr, "/merge_commit_sha") != Some(sha)
        || str_at(pr, "/head/sha") != Some(head)
    {
        return Err(format!(
            "PR {number} does not read back merged at --head by {sha}; inspect PR-READBACK.json"
        ));
    }
    // Exactly the two entries GitHub sent, each a full commit id: a malformed or extra entry is
    // refused, never skipped.
    let parents: Option<Vec<&str>> = commit["parents"]
        .as_array()
        .filter(|entries| entries.len() == 2)
        .and_then(|entries| {
            entries
                .iter()
                .map(|entry| entry["sha"].as_str().filter(|id| full_id(id)))
                .collect()
        });
    let second_is_head = parents.as_deref().is_some_and(|p| p[1] == head);
    if str_at(commit, "/sha") != Some(sha) || !second_is_head {
        return Err(
            "the merge does not read back as a merge commit of --head; inspect MERGE-COMMIT-READBACK.json"
                .into(),
        );
    }
    if parents.as_deref().is_some_and(|p| p[0] != base) {
        return Err(
            "a merge was made, but onto a base other than the approved one (it moved after the checks): \
             it is not the reviewed operation; inspect MERGE-COMMIT-READBACK.json and do not retry"
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HEAD: &str = "1111111111111111111111111111111111111111";
    const SHA: &str = "2222222222222222222222222222222222222222";

    fn pr() -> Value {
        json!({
            "number": 7, "state": "open", "merged": false, "draft": false, "title": "T",
            "body": "B\n", "head": { "sha": HEAD }, "mergeable": true, "mergeable_state": "clean",
        })
    }

    #[test]
    fn a_pr_is_ready_only_when_every_field_says_so() {
        assert!(ready(&pr(), 7, HEAD, "T", "B\n").is_ok());
        let cases: [(&str, Value, &str); 9] = [
            ("/number", json!(8), "reads back as number 8"),
            ("/state", json!("closed"), "not open"),
            ("/merged", json!(true), "not open"),
            ("/draft", json!(true), "a draft"),
            ("/head", json!({ "sha": SHA }), "it moved"),
            ("/title", json!("Other"), "not the reviewed text"),
            ("/body", json!("Other\n"), "not the reviewed text"),
            ("/mergeable", Value::Null, "may still be computing"),
            (
                "/mergeable_state",
                json!("blocked"),
                "mergeable_state is blocked",
            ),
        ];
        for (pointer, value, why) in cases {
            let mut changed = pr();
            *changed.pointer_mut(pointer).unwrap() = value;
            let error = ready(&changed, 7, HEAD, "T", "B\n").unwrap_err();
            assert!(error.contains(why), "{pointer}: {error}");
        }
    }

    fn run(conclusion: &str) -> Value {
        json!({ "name": "image", "head_sha": HEAD, "status": "completed", "conclusion": conclusion })
    }

    #[test]
    fn checks_pass_only_when_every_run_on_the_head_passed() {
        let none = json!({ "state": "pending", "total_count": 0 });
        let runs = |list: Vec<Value>| json!({ "total_count": list.len(), "check_runs": list });
        assert_eq!(
            checks_green(&runs(vec![run("success"), run("skipped")]), &none, HEAD),
            Ok(2)
        );
        for (list, why) in [
            (vec![], "no check run"),
            (vec![run("success"), run("failure")], "concluded failure"),
            (vec![run("cancelled")], "concluded cancelled"),
            (
                vec![json!({ "name": "image", "head_sha": HEAD, "status": "in_progress" })],
                "not completed",
            ),
            (
                vec![
                    json!({ "name": "image", "head_sha": SHA, "status": "completed", "conclusion": "success" }),
                ],
                "another commit",
            ),
        ] {
            let error = checks_green(&runs(list), &none, HEAD).unwrap_err();
            assert!(error.contains(why), "{error}");
        }
        let partial = json!({ "total_count": 3, "check_runs": [run("success")] });
        assert!(
            checks_green(&partial, &none, HEAD)
                .unwrap_err()
                .contains("one page")
        );
        let failing = json!({ "state": "failure", "total_count": 1 });
        assert!(
            checks_green(&runs(vec![run("success")]), &failing, HEAD)
                .unwrap_err()
                .contains("combined status is failure")
        );
    }

    #[test]
    fn every_comment_review_and_review_comment_is_scanned_and_a_full_page_refuses() {
        let one = |body: &str| json!([{ "id": 5, "body": body }]);
        let texts = public_texts(&pr(), &one("c"), &one("r"), &one("rc")).unwrap();
        let labels: Vec<&str> = texts.iter().map(|(label, _)| label.as_str()).collect();
        assert_eq!(
            labels,
            [
                "the PR title",
                "the PR body",
                "comment 5",
                "review 5",
                "review comment 5"
            ]
        );
        let full = Value::Array(vec![json!({ "id": 1, "body": "x" }); 100]);
        assert!(public_texts(&pr(), &full, &json!([]), &json!([])).is_err());
    }

    #[test]
    fn only_a_merge_commit_of_the_head_reads_back_as_merged() {
        assert_eq!(
            merge_reply(&json!({ "merged": true, "sha": SHA })),
            Ok(SHA.to_owned())
        );
        assert!(merge_reply(&json!({ "merged": false, "sha": SHA })).is_err());
        assert!(merge_reply(&json!({ "merged": true, "sha": "abc" })).is_err());
        let after = json!({ "number": 7, "merged": true, "merge_commit_sha": SHA, "head": { "sha": HEAD } });
        let base = "3333333333333333333333333333333333333333";
        let commit = |parents: &[&str]| json!({ "sha": SHA, "parents": parents.iter().map(|p| json!({ "sha": p })).collect::<Vec<_>>() });
        assert!(merged(&after, &commit(&[base, HEAD]), 7, HEAD, SHA, base).is_ok());
        // Malformed, missing or extra parent entries are refused, never skipped.
        let raw = |parents: Value| json!({ "sha": SHA, "parents": parents });
        for parents in [
            json!([{ "sha": base }, { "sha": HEAD }, {}]),
            json!([{ "sha": base }, { "sha": HEAD }, { "sha": base }]),
            json!([{ "sha": base }, {}]),
            json!([{}, { "sha": HEAD }]),
            json!([{ "sha": "not-a-commit" }, { "sha": HEAD }]),
            json!([{ "sha": "ABCDEF0123456789ABCDEF0123456789ABCDEF01" }, { "sha": HEAD }]),
            json!([{ "sha": 7 }, { "sha": HEAD }]),
            json!({ "sha": HEAD }),
            Value::Null,
        ] {
            assert!(
                merged(&after, &raw(parents.clone()), 7, HEAD, SHA, base).is_err(),
                "{parents}"
            );
        }
        // A squash (one parent) or a rebase (head is not a parent) is not a merge commit.
        assert!(merged(&after, &commit(&[base]), 7, HEAD, SHA, base).is_err());
        assert!(merged(&after, &commit(&[base, base]), 7, HEAD, SHA, base).is_err());
        let mut other = after.clone();
        other["merge_commit_sha"] = json!(base);
        assert!(merged(&other, &commit(&[base, HEAD]), 7, HEAD, SHA, base).is_err());
        // A merge onto any first parent but the approved base is reported as not the reviewed one.
        let moved = "4444444444444444444444444444444444444444";
        let wrong = merged(&after, &commit(&[moved, HEAD]), 7, HEAD, SHA, base).unwrap_err();
        assert!(wrong.contains("other than the approved one"), "{wrong}");
        assert!(wrong.contains("do not retry"), "{wrong}");
    }

    #[test]
    fn only_a_pr_onto_the_approved_branch_at_the_approved_base_is_the_target() {
        const BASE: &str = "3333333333333333333333333333333333333333";
        let target = |repo: &str, branch: &str, sha: &str| json!({ "base": { "ref": branch, "sha": sha, "repo": { "full_name": repo } } });
        assert!(
            targets(
                &target("owner/demo", "main", BASE),
                "owner/demo",
                "main",
                BASE
            )
            .is_ok()
        );
        let moved = "4444444444444444444444444444444444444444";
        for (pr, why) in [
            (target("owner/demo", "release", moved), "targets release"),
            (target("owner/demo", "release", BASE), "targets release"),
            (
                target("owner/demo", "main", moved),
                "not at the approved base",
            ),
            (target("other/demo", "main", BASE), "not in owner/demo"),
            (
                json!({ "base": { "repo": { "full_name": "owner/demo" }, "sha": BASE } }),
                "targets no branch",
            ),
            (
                json!({ "base": { "repo": { "full_name": "owner/demo" }, "ref": "main" } }),
                "not at the approved base",
            ),
            (json!({}), "not in owner/demo"),
        ] {
            let refusal = targets(&pr, "owner/demo", "main", BASE).unwrap_err();
            assert!(refusal.contains(why), "{pr}: {refusal}");
        }
    }
}
