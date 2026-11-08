//! What a PR says about where its head may be pushed. A fast-forward goes to the PR's own head ref
//! in the PR's own head repository, which is the base repository or a fork that lets maintainers
//! push (`maintainer_can_modify`). Nothing else is ever a push target.
use serde_json::Value;

/// Where a PR's head lives and what it points at now.
#[derive(Debug, PartialEq, Eq)]
pub struct Target {
    /// `OWNER/NAME` of the head repository.
    pub repo: String,
    /// The head branch, without `refs/heads/`.
    pub branch: String,
    /// The PR's base branch.
    pub base: String,
    pub fork: bool,
}

impl Target {
    /// Reads `pr` (GitHub's PR object) for `repo`, requiring it open, based in `repo`, with its
    /// head at `old`; a fork head also needs `maintainer_can_modify`.
    pub fn from_pr(pr: &Value, repo: &str, old: &str) -> Result<Self, String> {
        let text = |pointer: &str| {
            pr.pointer(pointer)
                .and_then(Value::as_str)
                .ok_or_else(|| format!("the PR has no {pointer}"))
        };
        if text("/state")? != "open" {
            return Err("the PR is not open".into());
        }
        if text("/base/repo/full_name")? != repo {
            return Err(format!("the PR does not target {repo}"));
        }
        if text("/head/sha")? != old {
            return Err("the PR's head is not --old: it moved, or --old is wrong".into());
        }
        let head_repo = text("/head/repo/full_name")?;
        let fork = head_repo != repo;
        if fork && pr.pointer("/maintainer_can_modify") != Some(&Value::Bool(true)) {
            return Err(format!(
                "the PR's head is in the fork {head_repo}, which does not allow maintainer pushes"
            ));
        }
        let branch = text("/head/ref")?;
        if branch.is_empty() || branch.starts_with('-') || branch.contains("..") {
            return Err(format!("unusable head branch {branch:?}"));
        }
        Ok(Self {
            repo: head_repo.to_owned(),
            branch: branch.to_owned(),
            base: text("/base/ref")?.to_owned(),
            fork,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pr(head_repo: &str, can_modify: bool) -> Value {
        json!({
            "state": "open",
            "maintainer_can_modify": can_modify,
            "head": { "sha": "a1", "ref": "topic", "repo": { "full_name": head_repo } },
            "base": { "ref": "main", "repo": { "full_name": "owner/demo" } },
        })
    }

    #[test]
    fn a_same_repo_head_or_a_fork_that_allows_maintainers_is_a_target() {
        let same = Target::from_pr(&pr("owner/demo", false), "owner/demo", "a1").unwrap();
        assert_eq!(
            same,
            Target {
                repo: "owner/demo".into(),
                branch: "topic".into(),
                base: "main".into(),
                fork: false
            }
        );
        let fork = Target::from_pr(&pr("zorblat/demo", true), "owner/demo", "a1").unwrap();
        assert!(fork.fork);
        assert_eq!(fork.repo, "zorblat/demo");
    }

    #[test]
    fn a_closed_moved_foreign_or_locked_fork_pr_is_refused() {
        let refused = |pr: Value, repo: &str, old: &str, why: &str| {
            let error = Target::from_pr(&pr, repo, old).unwrap_err();
            assert!(error.contains(why), "{error}");
        };
        refused(
            pr("zorblat/demo", false),
            "owner/demo",
            "a1",
            "does not allow",
        );
        let mut no_flag = pr("zorblat/demo", true);
        no_flag
            .as_object_mut()
            .unwrap()
            .remove("maintainer_can_modify");
        refused(no_flag, "owner/demo", "a1", "does not allow");
        refused(pr("owner/demo", false), "owner/demo", "b2", "moved");
        refused(
            pr("owner/demo", false),
            "owner/other",
            "a1",
            "does not target",
        );
        let mut closed = pr("owner/demo", false);
        closed["state"] = json!("closed");
        refused(closed, "owner/demo", "a1", "not open");
        let mut odd = pr("owner/demo", false);
        odd["head"]["ref"] = json!("--upload-pack=x");
        refused(odd, "owner/demo", "a1", "unusable head branch");
    }
}
