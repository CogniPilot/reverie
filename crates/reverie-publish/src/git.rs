//! `git` with explicit argv against one object store, no shell, no credential helper, no user
//! or system config, and none of the environment variables that redirect or trace git.
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::{Command, Output},
};

/// Variables removed from git's environment: they redirect the repository, leak traffic or carry
/// a token that must only ever come from the token file.
const SCRUBBED: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CURL_VERBOSE",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GH_TOKEN",
    "GITHUB_TOKEN",
];

#[derive(Debug, Clone)]
pub struct Git {
    git_dir: PathBuf,
}

impl Git {
    pub fn new(git_dir: &Path) -> Self {
        Self {
            git_dir: git_dir.to_path_buf(),
        }
    }

    fn command<I, S>(&self, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut command = Command::new("git");
        for (key, _) in std::env::vars_os() {
            let name = key.to_string_lossy();
            if SCRUBBED.contains(&name.as_ref()) || name.starts_with("GIT_TRACE") {
                command.env_remove(&key);
            }
        }
        command
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .arg("-c")
            .arg("credential.helper=")
            .arg("--git-dir")
            .arg(&self.git_dir)
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

    /// Verifies a bundle and fetches all its refs under `refs/publish/<label>/`.
    pub fn import_bundle(&self, bundle: &Path, label: &str) -> Result<(), String> {
        let bundle = bundle.to_string_lossy().into_owned();
        self.run(["bundle", "verify", "--quiet", &bundle])?;
        let refspec = format!("+refs/*:refs/publish/{label}/*");
        self.run(["fetch", "--quiet", "--no-tags", &bundle, &refspec])?;
        Ok(())
    }
}
