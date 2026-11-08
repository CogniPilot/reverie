//! Minting a merge-main: the merge of current main into a PR's head that lets the PR land without
//! rewriting its published history. The merge commit has the PR head as its first parent and main
//! as its second, carries one identity with its own sign-off, and has exactly the tree
//! `git merge-tree` computes. Its delta over the PR head must be what main itself changed since
//! the PR last took main, line for line, so a merge-main never smuggles in anything else.
use crate::{commits, git::Git};
use reverie_namegate::{Kind, Lists};

/// The identity a merge-main is minted with.
pub const IDENTITY: (&str, &str) = ("James Goppert", "jgoppert@users.noreply.github.com");

/// A minted merge-main and what was checked about it.
#[derive(Debug)]
pub struct Minted {
    pub commit: String,
    pub tree: String,
    pub head: String,
    pub main: String,
    /// The merge base of head and main: main's state when the PR last took it.
    pub base: String,
    /// `git diff -U0 head commit`, and main's own `git diff -U0 base main`.
    pub delta: String,
    pub main_delta: String,
}

/// Resolves `id` to a commit and requires it to be that full id already.
fn full_commit(git: &Git, id: &str, what: &str) -> Result<String, String> {
    let resolved = git.run([
        "rev-parse",
        "--verify",
        "--end-of-options",
        &format!("{id}^{{commit}}"),
    ])?;
    if resolved != id {
        return Err(format!(
            "{what} must be the full id of a commit in the store"
        ));
    }
    Ok(resolved)
}

/// The change lines of a `-U0` diff, per file, without hunk positions or index lines, which
/// differ between a merge's delta and main's own whenever the PR moved lines around. `---` and
/// `+++` are file headers only before a file's first hunk; inside hunks every `+` or `-` line is
/// content, whatever it starts with.
pub fn change_lines(diff: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut in_hunk = false;
    for line in diff.lines() {
        if line.starts_with("diff --git ") {
            in_hunk = false;
            out.push(line);
        } else if line.starts_with("@@") {
            in_hunk = true;
        } else if in_hunk {
            if line.starts_with('+') || line.starts_with('-') {
                out.push(line);
            }
        } else if [
            "new file mode",
            "deleted file mode",
            "old mode",
            "new mode",
            "Binary files",
        ]
        .iter()
        .any(|prefix| line.starts_with(prefix))
        {
            out.push(line);
        }
    }
    out
}

/// Mints the merge of `main` into `head` with `subject`, checks it, and keeps it reachable under
/// `refs/publish/mint/<commit>`. Refuses a conflicted merge (those are resolved and reviewed by
/// hand), a criss-cross history, and a merge whose delta is not main's own change.
pub fn mint(
    git: &Git,
    lists: &Lists,
    repo: &str,
    head: &str,
    main: &str,
    subject: &str,
) -> Result<Minted, String> {
    let head = full_commit(git, head, "--head")?;
    let main = full_commit(git, main, "--main")?;
    if git.succeeds(["merge-base", "--is-ancestor", &main, &head])? {
        return Err("the head already contains main; there is nothing to merge".into());
    }
    let bases = git.run(["merge-base", "--all", &head, &main])?;
    let base = match bases.lines().collect::<Vec<_>>().as_slice() {
        [one] => (*one).to_owned(),
        [] => return Err("head and main share no history".into()),
        _ => return Err("head and main have several merge bases; mint this one by hand".into()),
    };
    if !git.succeeds(["merge-tree", "--write-tree", &head, &main])? {
        return Err("main does not merge cleanly into the head; resolve it by hand".into());
    }
    let tree = git.run(["merge-tree", "--write-tree", &head, &main])?;
    if subject.trim().is_empty() || subject.contains('\n') {
        return Err("the merge subject is one non-empty line".into());
    }
    // Nothing is minted with a message rule 8 would refuse anyway.
    commits::clean(lists, subject, Kind::Text, repo, "the merge message")?;
    let (name, email) = IDENTITY;
    let signoff = format!("Signed-off-by: {name} <{email}>");
    let commit = git.run([
        "-c",
        &format!("user.name={name}"),
        "-c",
        &format!("user.email={email}"),
        "commit-tree",
        &tree,
        "-p",
        &head,
        "-p",
        &main,
        "-m",
        subject,
        "-m",
        &signoff,
    ])?;
    git.run([
        "update-ref",
        &format!("refs/publish/mint/{commit}"),
        &commit,
    ])?;
    // The minted object itself, read back: parents in order, the computed tree, one identity.
    let raw = git.run(["cat-file", "commit", &commit])?;
    let parents: Vec<&str> = raw
        .lines()
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.strip_prefix("parent "))
        .collect();
    if parents != [head.as_str(), main.as_str()] || !raw.starts_with(&format!("tree {tree}\n")) {
        return Err("the minted commit does not read back with the head, main and tree".into());
    }
    commits::check_range(git, lists, repo, &[&commit, "--not", &head, &main], &commit)?;
    let delta = git.run([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "-U0",
        &head,
        &commit,
    ])?;
    let main_delta = git.run([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "-U0",
        &base,
        &main,
    ])?;
    if change_lines(&delta) != change_lines(&main_delta) {
        return Err(format!(
            "the merge's delta over the head is not main's own change since {base}; \
             overlapping changes need a hand-reviewed merge (minted {commit} is kept for inspection)"
        ));
    }
    Ok(Minted {
        commit,
        tree,
        head,
        main,
        base,
        delta,
        main_delta,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn change_lines_drop_positions_and_index_lines_only() {
        let at_ten =
            "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -10 +10 @@\n-old\n+new\n";
        let at_two =
            "diff --git a/x b/x\nindex 3..4 100644\n--- a/x\n+++ b/x\n@@ -2 +2 @@\n-old\n+new\n";
        assert_eq!(change_lines(at_ten), change_lines(at_two));
        assert_eq!(change_lines(at_ten), ["diff --git a/x b/x", "-old", "+new"]);
        let other = at_two.replace("+new", "+newer");
        assert_ne!(change_lines(at_ten), change_lines(&other));
        let added = "diff --git a/y b/y\nnew file mode 100644\n--- /dev/null\n+++ b/y\n@@ -0,0 +1 @@\n+--- a line\n";
        assert_eq!(
            change_lines(added),
            ["diff --git a/y b/y", "new file mode 100644", "+--- a line"]
        );
        let removed = "diff --git a/z b/z\n--- a/z\n+++ b/z\n@@ -3 +2,0 @@\n--- note\n";
        assert_eq!(change_lines(removed), ["diff --git a/z b/z", "--- note"]);
    }
}
