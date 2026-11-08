//! The checks every published commit passes: one allowed identity as both author and committer,
//! sign-offs only by that identity (at least one), and no blocking name in its message or in the
//! lines it adds. A merge is judged by `--remerge-diff`, so only what the merge itself adds counts.
use crate::git::Git;
use reverie_namegate::{Kind, Lists, scan};

/// The identities a published commit may carry.
pub const IDENTITIES: &[&str] = &[
    "James Goppert <jgoppert@users.noreply.github.com>",
    "James Goppert <473772+jgoppert@users.noreply.github.com>",
];

/// What one commit contributed, for the summary.
#[derive(Debug)]
pub struct Checked {
    pub commit: String,
    pub merge: bool,
    pub added_lines: usize,
}

/// The identity of a raw commit object, checked: the same allowed identity as author and
/// committer, and every `Signed-off-by:` line naming it (at least one).
pub fn identity(raw: &str) -> Result<&'static str, String> {
    let (headers, message) = raw.split_once("\n\n").unwrap_or((raw, ""));
    let person = |field: &str| {
        headers
            .lines()
            .find_map(|line| line.strip_prefix(field))
            .map(|rest| rest.rsplitn(3, ' ').nth(2).unwrap_or(rest))
    };
    let author = person("author ").ok_or("commit has no author")?;
    let committer = person("committer ").ok_or("commit has no committer")?;
    let who = IDENTITIES
        .iter()
        .copied()
        .find(|id| *id == author)
        .ok_or_else(|| format!("author is not an allowed identity: {author}"))?;
    if committer != who {
        return Err(format!("committer differs from author: {committer}"));
    }
    // Any spelling of the trailer counts, so a foreign sign-off cannot hide in another case.
    const TRAILER: &str = "signed-off-by:";
    let signoffs: Vec<&str> = message
        .lines()
        .filter(|line| {
            line.get(..TRAILER.len())
                .is_some_and(|key| key.eq_ignore_ascii_case(TRAILER))
        })
        .map(|line| line[TRAILER.len()..].trim())
        .collect();
    if signoffs.is_empty() {
        return Err("commit has no Signed-off-by".into());
    }
    if let Some(other) = signoffs.iter().find(|s| **s != who) {
        return Err(format!("Signed-off-by by another identity: {other}"));
    }
    Ok(who)
}

/// Blocks when namegate finds a blocking name; reports categories only, never the text.
pub fn clean(lists: &Lists, text: &str, kind: Kind, repo: &str, what: &str) -> Result<(), String> {
    let outcome = scan(lists, text, kind, repo);
    if outcome.blocking.is_empty() {
        return Ok(());
    }
    let categories: Vec<&str> = outcome.blocking.iter().map(|f| f.category.name()).collect();
    Err(format!(
        "rule 8: {what} has blocking names ({})",
        categories.join(", ")
    ))
}

/// Checks every commit in `range` (as `git rev-list` reads it, oldest first) and returns them.
/// `tip` must be the newest, so nothing beyond it rides along.
pub fn check_range(
    git: &Git,
    lists: &Lists,
    repo: &str,
    range: &[&str],
    tip: &str,
) -> Result<Vec<Checked>, String> {
    let mut args = vec!["rev-list", "--reverse"];
    args.extend_from_slice(range);
    let commits: Vec<String> = git.run(args)?.lines().map(str::to_owned).collect();
    match commits.last() {
        None => return Err("no commits to publish".into()),
        Some(last) if last != tip => return Err(format!("range ends at {last}, not at {tip}")),
        Some(_) => {}
    }
    let mut checked = Vec::new();
    for commit in commits {
        let raw = git.run(["cat-file", "commit", &commit])?;
        identity(&raw).map_err(|e| format!("{commit}: {e}"))?;
        let message = raw.split_once("\n\n").map_or("", |(_, m)| m);
        clean(
            lists,
            message,
            Kind::Text,
            repo,
            &format!("{commit} message"),
        )?;
        let parents = git.run(["rev-list", "--parents", "-n", "1", &commit])?;
        let merge = parents.split_whitespace().count() > 2;
        let mut show = vec!["show", "--no-ext-diff", "--no-textconv", "--format="];
        if merge {
            show.push("--remerge-diff");
        }
        show.push(&commit);
        let diff = git.run(show)?;
        let added = added_lines(&diff);
        clean(
            lists,
            &added.join("\n"),
            Kind::Code,
            repo,
            &format!("{commit} added lines"),
        )?;
        let names = git.run(["show", "--no-ext-diff", "--name-only", "--format=", &commit])?;
        clean(
            lists,
            &names,
            Kind::Code,
            repo,
            &format!("{commit} file names"),
        )?;
        checked.push(Checked {
            commit,
            merge,
            added_lines: added.len(),
        });
    }
    Ok(checked)
}

/// The lines a diff adds: `+` lines inside `@@` hunks only. The `+++ b/path` file header comes
/// before a file's first hunk, so an added line that itself begins with `++` is still caught.
pub fn added_lines(diff: &str) -> Vec<&str> {
    let mut in_hunk = false;
    let mut added = Vec::new();
    for line in diff.lines() {
        if line.starts_with("diff ") {
            in_hunk = false;
        } else if line.starts_with("@@") {
            in_hunk = true;
        } else if in_hunk && let Some(rest) = line.strip_prefix('+') {
            added.push(rest);
        }
    }
    added
}

#[cfg(test)]
mod tests {
    use super::*;

    const JAMES: &str = "James Goppert <jgoppert@users.noreply.github.com>";

    fn raw(author: &str, committer: &str, message: &str) -> String {
        format!("tree 0\nauthor {author} 1 +0000\ncommitter {committer} 1 +0000\n\n{message}")
    }

    #[test]
    fn added_lines_come_only_from_hunks_and_keep_lines_starting_with_plus_plus() {
        let diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1,2 @@\n+plain\n+++hidden\ndiff --git a/y b/y\n+++ b/y\n@@ -1 +1 @@\n-old\n+new\n";
        assert_eq!(added_lines(diff), vec!["plain", "++hidden", "new"]);
    }

    #[test]
    fn a_foreign_signoff_in_another_case_is_still_a_signoff() {
        let other = "Someone Else <else@example.invalid>";
        let message = format!("Subject\n\nSigned-off-by: {JAMES}\nsigned-off-by: {other}\n");
        assert!(identity(&raw(JAMES, JAMES, &message)).is_err());
    }

    #[test]
    fn accepts_one_identity_with_its_own_signoff() {
        let ok = raw(
            JAMES,
            JAMES,
            &format!("Subject\n\nSigned-off-by: {JAMES}\n"),
        );
        assert_eq!(identity(&ok), Ok(JAMES));
    }

    #[test]
    fn refuses_a_foreign_author_a_split_committer_or_a_missing_or_foreign_signoff() {
        let other = "Someone Else <else@example.invalid>";
        let signed = format!("Subject\n\nSigned-off-by: {JAMES}\n");
        assert!(identity(&raw(other, other, &signed)).is_err());
        assert!(identity(&raw(JAMES, IDENTITIES[1], &signed)).is_err());
        assert!(identity(&raw(JAMES, JAMES, "Subject\n")).is_err());
        let extra = format!("Subject\n\nSigned-off-by: {JAMES}\nSigned-off-by: {other}\n");
        assert!(identity(&raw(JAMES, JAMES, &extra)).is_err());
    }
}
