//! `git` with explicit argv against one object store, no shell, no credential helper, no hooks,
//! no replacement objects, no user or system config, and no `GIT_*` variable from the caller: any
//! of them could redirect, reconfigure (`GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS`), trace or run
//! code inside git. The object store is held (see `custody`): git starts inside the held directory
//! with `--git-dir .`, so a symlink on the store's path is refused and a swap of the path later
//! cannot point git at another store.
use crate::custody::Held;
use std::{
    ffi::OsStr,
    path::Path,
    process::{Command, Output},
};

/// Variables removed from git's environment besides every `GIT_*` one: they carry a token or a
/// credential prompt that must only ever come from this binary.
const SCRUBBED: &[&str] = &["SSH_ASKPASS", "GH_TOKEN", "GITHUB_TOKEN"];

#[derive(Debug)]
pub struct Git {
    store: Held,
}

impl Git {
    /// Holds the object store at `git_dir`, refusing a path through a symlink.
    pub fn open(git_dir: &Path) -> Result<Self, String> {
        Ok(Self {
            store: Held::open(git_dir)?,
        })
    }

    /// The held store, for files this process writes into it.
    pub fn store(&self) -> &Held {
        &self.store
    }

    fn command<I, S>(&self, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut command = Command::new("git");
        for (key, _) in std::env::vars_os() {
            let name = key.to_string_lossy();
            if SCRUBBED.contains(&name.as_ref()) || name.starts_with("GIT_") {
                command.env_remove(&key);
            }
        }
        command
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .args(["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null"])
            .args(["--git-dir", "."])
            .current_dir(self.store.proc_path())
            .args(args);
        command
    }

    fn output<I, S>(&self, args: I) -> Result<Output, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.command(args)
            .output()
            .map_err(|e| format!("could not run git: {e}"))
    }

    /// Runs git and returns stdout with the trailing newline removed; a nonzero exit is an error
    /// carrying git's stderr.
    pub fn run<I, S>(&self, args: I) -> Result<String, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        Ok(String::from_utf8_lossy(&self.bytes(args)?)
            .trim_end_matches('\n')
            .to_owned())
    }

    /// Like `run`, but the raw stdout bytes.
    pub fn bytes<I, S>(&self, args: I) -> Result<Vec<u8>, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = self.output(args)?;
        if !output.status.success() {
            return Err(format!(
                "git failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(output.stdout)
    }

    /// Whether git exits zero (for predicates such as `merge-base --is-ancestor`).
    pub fn succeeds<I, S>(&self, args: I) -> Result<bool, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        Ok(self.output(args)?.status.success())
    }

    /// `git push <url> <refspec>` without force. With `token_file`, git asks this binary for the
    /// credentials (`GIT_ASKPASS`, answered by `askpass::answer`), so the token never reaches argv,
    /// the environment of anything but this binary, or a shell. Returns (success, stderr).
    pub fn push(
        &self,
        url: &str,
        refspec: &str,
        token_file: Option<&Path>,
    ) -> Result<(bool, String), String> {
        self.push_with(url, refspec, None, token_file)
    }

    /// Creates `reference` at `head` on the remote only if it does not exist there. git sends the
    /// all-zero old id for it, so the remote refuses if the branch appeared after any earlier
    /// check, even when the update would be a fast-forward. Returns (success, stderr).
    pub fn push_new(
        &self,
        url: &str,
        head: &str,
        reference: &str,
        token_file: Option<&Path>,
    ) -> Result<(bool, String), String> {
        let lease = format!("--force-with-lease={reference}:");
        self.push_with(
            url,
            &format!("{head}:{reference}"),
            Some(&lease),
            token_file,
        )
    }

    fn push_with(
        &self,
        url: &str,
        refspec: &str,
        lease: Option<&str>,
        token_file: Option<&Path>,
    ) -> Result<(bool, String), String> {
        if refspec.starts_with('+') || refspec.contains(":+") {
            return Err("a forced refspec is never pushed".into());
        }
        // A redirect is never followed, so credentials go only to the URL given.
        let mut args = vec!["-c", "http.followRedirects=false", "push", "--porcelain"];
        args.extend(lease);
        args.extend([url, refspec]);
        let mut command = self.command(args);
        if let Some(token_file) = token_file {
            let me =
                std::env::current_exe().map_err(|e| format!("cannot find this binary: {e}"))?;
            command
                .env("GIT_ASKPASS", me)
                .env(crate::askpass::MODE, "1")
                // git and its askpass child start in the held store, so a relative path would
                // name a file there.
                .env(
                    crate::askpass::TOKEN_FILE,
                    std::path::absolute(token_file)
                        .map_err(|e| format!("token file: {}", e.kind()))?,
                );
        }
        let output = command
            .output()
            .map_err(|e| format!("could not run git: {e}"))?;
        Ok((
            output.status.success(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ))
    }

    /// The commit a remote ref points at, or None when the ref does not exist.
    pub fn remote_ref(&self, url: &str, reference: &str) -> Result<Option<String>, String> {
        let listed = self.run(["ls-remote", url, reference])?;
        Ok(listed
            .lines()
            .find(|line| line.split_whitespace().nth(1) == Some(reference))
            .and_then(|line| line.split_whitespace().next())
            .map(str::to_owned))
    }

    /// Fetches one remote branch to `refs/publish/<label>` and returns its commit.
    pub fn fetch_branch(&self, url: &str, branch: &str, label: &str) -> Result<String, String> {
        let local = format!("refs/publish/{label}");
        self.run([
            "fetch",
            "--quiet",
            "--no-tags",
            url,
            &format!("+refs/heads/{branch}:{local}"),
        ])?;
        self.run(["rev-parse", "--verify", &format!("{local}^{{commit}}")])
    }

    /// Writes `bytes` to a new private bundle file in the store, verifies it and fetches all its
    /// refs under `refs/publish/<label>/<run>/`, where `<run>` is the copy's own unique name, so
    /// concurrent imports share no file and no ref. The copy is removed afterwards. Returns the
    /// ref prefix.
    pub fn import_bundle(&self, bytes: &[u8], label: &str) -> Result<String, String> {
        let copy = self
            .store
            .create_unique("publish-packet", "bundle", bytes)?;
        let run = copy.name().trim_end_matches(".bundle");
        let bundle = format!("./{}", copy.name());
        self.run(["bundle", "verify", "--quiet", &bundle])?;
        let prefix = format!("refs/publish/{label}/{run}/");
        let refspec = format!("+refs/*:{prefix}*");
        self.run([
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            &bundle,
            &refspec,
        ])?;
        Ok(prefix)
    }

    /// Whether `commit` is the tip of a ref under `prefix` (a tag peeled to its commit): what an
    /// `import_bundle` of this run brought in, as opposed to anything else already in the store.
    pub fn is_imported_tip(&self, prefix: &str, commit: &str) -> Result<bool, String> {
        let tips = self.run([
            "for-each-ref",
            "--format=%(objectname)%0a%(*objectname)",
            prefix,
        ])?;
        Ok(tips.lines().any(|tip| tip == commit))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn init(path: &Path, marker: &str) {
        for args in [
            vec!["init", "-q", "--bare"],
            vec!["config", "publish.marker", marker],
        ] {
            let status = Command::new("git")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .arg("--git-dir")
                .arg(path)
                .args(args)
                .status()
                .unwrap();
            assert!(status.success());
        }
    }

    #[test]
    fn git_keeps_working_in_the_held_store_after_its_path_is_swapped() {
        let root = std::env::temp_dir().join(format!("publish-git-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        init(&root.join("store.git"), "held");
        let git = Git::open(&root.join("store.git")).unwrap();
        fs::rename(root.join("store.git"), root.join("store-moved.git")).unwrap();
        init(&root.join("store.git"), "substituted");
        assert_eq!(git.run(["config", "publish.marker"]).unwrap(), "held");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_forced_refspec_is_refused_before_git_runs() {
        let git = Git::open(&std::env::temp_dir()).unwrap();
        for refspec in ["+abc:refs/heads/x", "abc:+refs/heads/x"] {
            let error = git
                .push("/nonexistent/remote.git", refspec, None)
                .unwrap_err();
            assert!(error.contains("never pushed"), "{error}");
        }
    }
}
