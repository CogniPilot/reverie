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
    let signoffs: Vec<&str> = message
        .lines()
        .filter_map(|line| line.strip_prefix("Signed-off-by:"))
        .map(str::trim)
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
        let diff = if merge {
            git.run(["show", "--remerge-diff", "--format=", &commit])?
        } else {
            git.run(["show", "--format=", &commit])?
        };
        let added: Vec<&str> = diff
            .lines()
            .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
            .map(|line| &line[1..])
            .collect();
        clean(
            lists,
            &added.join("\n"),
            Kind::Code,
            repo,
            &format!("{commit} added lines"),
        )?;
        let names = git.run(["show", "--name-only", "--format=", &commit])?;
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

#[cfg(test)]
mod tests {
    use super::*;

    const JAMES: &str = "James Goppert <jgoppert@users.noreply.github.com>";

    fn raw(author: &str, committer: &str, message: &str) -> String {
        format!("tree 0\nauthor {author} 1 +0000\ncommitter {committer} 1 +0000\n\n{message}")
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
