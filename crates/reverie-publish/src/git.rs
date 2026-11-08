//! `git` with explicit argv against one object store, no shell, no credential helper, no hooks,
//! no replacement objects, no user or system config, and no `GIT_*` variable from the caller: any
//! of them could redirect, reconfigure (`GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS`), trace or run
//! code inside git. The object store is held (see `custody`): git starts inside the held directory
//! with its objects there, so a symlink on the store's path is refused and a swap of the path later
//! cannot point git at another store.
//!
//! git never reads the store's own config, attributes or refs either: every command runs against a
//! fresh private git directory (`Private`) whose only config is what `git init` writes, with the
//! store's objects (`GIT_OBJECT_DIRECTORY`). A `url.*.insteadOf`, `pushInsteadOf`, `protocol.*`,
//! `core.attributesFile`, merge driver or `include.path` placed in the store therefore changes
//! nothing a check, fetch or push does. Network commands (`fetch`, `ls-remote`, `push`) each get a
//! further fresh directory of their own (`Transport`).
use crate::custody::Held;
use std::{
    collections::BTreeSet,
    ffi::OsStr,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
};

/// Variables removed from git's environment besides every `GIT_*` one: they carry a token or a
/// credential prompt that must only ever come from this binary.
const SCRUBBED: &[&str] = &["SSH_ASKPASS", "GH_TOKEN", "GITHUB_TOKEN"];

#[derive(Debug)]
pub struct Git {
    store: Held,
    private: Private,
}

/// A fresh private git directory: mode 0700 under the temporary directory, created new, with no
/// template. It holds this run's refs and config; it is removed when dropped.
#[derive(Debug)]
struct Private(PathBuf);

impl Drop for Private {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl Private {
    fn create() -> Result<Self, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let mut last = String::new();
        for _ in 0..8 {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "reverie-publish-git-{}-{nanos:x}-{n}",
                std::process::id()
            ));
            match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
                Ok(()) => return Ok(Self(dir)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last = e.to_string(),
                Err(e) => return Err(format!("private git directory: {e}")),
            }
        }
        Err(format!("private git directory: {last}"))
    }
}

impl Git {
    /// Holds the object store at `git_dir`, refusing a path through a symlink, and creates the
    /// private git directory every command uses.
    pub fn open(git_dir: &Path) -> Result<Self, String> {
        let git = Self {
            store: Held::open(git_dir)?,
            private: Private::create()?,
        };
        let init = git
            .command_in(
                git.private.0.as_os_str(),
                ["init", "--quiet", "--bare", "--template="],
            )
            .output()
            .map_err(|e| format!("could not run git: {e}"))?;
        if !init.status.success() {
            return Err(format!(
                "git init failed: {}",
                String::from_utf8_lossy(&init.stderr).trim()
            ));
        }
        Ok(git)
    }

    /// The held store, for files this process writes into it.
    pub fn store(&self) -> &Held {
        &self.store
    }

    /// The commit `revision` names: a full id as given, or a ref of the store read from its loose
    /// or packed ref files (no-follow, without running git, so no store config takes part). A
    /// name is tried as given under `refs/`, then as a branch, remote branch and tag.
    pub fn store_revision(&self, revision: &str) -> Result<String, String> {
        let is_id = |s: &str| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit());
        let id = if is_id(revision) {
            revision.to_owned()
        } else {
            self.store_ref(revision)?
                .ok_or_else(|| format!("{revision}: no such ref in the object store"))?
        };
        self.run([
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{id}^{{commit}}"),
        ])
    }

    /// A loose ref file of the store holding one full id, or None when it does not exist.
    fn loose_ref(&self, name: &str) -> Result<Option<String>, String> {
        let bytes = match self.store.read_regular(name, "the object store") {
            Ok(bytes) => bytes,
            Err(e) if e.contains(nix::errno::Errno::ENOENT.desc()) => return Ok(None),
            Err(e) => return Err(e),
        };
        let id = String::from_utf8_lossy(&bytes).trim().to_owned();
        if id.len() != 40 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("{name}: not a plain ref in the object store"));
        }
        Ok(Some(id))
    }

    fn store_ref(&self, name: &str) -> Result<Option<String>, String> {
        let candidates: Vec<String> = if name.starts_with("refs/") {
            vec![name.to_owned()]
        } else {
            ["refs/heads/", "refs/remotes/", "refs/tags/"]
                .iter()
                .map(|kind| format!("{kind}{name}"))
                .collect()
        };
        let packed = match self.store.read_regular("packed-refs", "the object store") {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(e) if e.contains(nix::errno::Errno::ENOENT.desc()) => String::new(),
            Err(e) => return Err(e),
        };
        for candidate in &candidates {
            if let Some(id) = self.loose_ref(candidate)? {
                return Ok(Some(id));
            }
            let found = packed.lines().find_map(|line| {
                let (id, refname) = line.split_once(' ')?;
                (refname == candidate && id.len() == 40).then(|| id.to_owned())
            });
            if found.is_some() {
                return Ok(found);
            }
        }
        Ok(None)
    }

    fn command<I, S>(&self, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut command = self.command_in(self.private.0.as_os_str(), args);
        // Relative to the held store git starts in.
        command.env("GIT_OBJECT_DIRECTORY", "objects");
        command
    }

    /// git started inside the held store, with `git_dir` as its repository.
    fn command_in<I, S>(&self, git_dir: &OsStr, args: I) -> Command
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
            // No system gitattributes, and no user attributes from $XDG_CONFIG_HOME or $HOME: an
            // ambient `merge=union` would otherwise make a real conflict merge cleanly.
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env_remove("XDG_CONFIG_HOME")
            .env("HOME", &self.private.0)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .args(["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null"])
            .args(["-c", "core.attributesFile=/dev/null"])
            .arg("--git-dir")
            .arg(git_dir)
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
        let transport = self.transport()?;
        let mut command = transport.command(args);
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
        let listed = self.transport()?.run(["ls-remote", url, reference])?;
        Ok(listed
            .lines()
            .find(|line| line.split_whitespace().nth(1) == Some(reference))
            .and_then(|line| line.split_whitespace().next())
            .map(str::to_owned))
    }

    /// Fetches one remote branch into the store's objects and returns its commit.
    pub fn fetch_branch(&self, url: &str, branch: &str, label: &str) -> Result<String, String> {
        let transport = self.transport()?;
        // The refs this run already holds, so the fetch asks only for what is missing.
        let mut tips: Vec<String> = self
            .run(["for-each-ref", "--format=%(objectname)"])?
            .lines()
            .map(str::to_owned)
            .collect();
        tips.sort();
        tips.dedup();
        let packed: String = tips
            .iter()
            .enumerate()
            .map(|(i, tip)| format!("{tip} refs/have/{i:08}\n"))
            .collect();
        std::fs::write(transport.dir.join("packed-refs"), packed)
            .map_err(|e| format!("transport refs: {}", e.kind()))?;
        let local = format!("refs/publish/{label}");
        transport.run([
            "fetch",
            "--quiet",
            "--no-tags",
            url,
            &format!("+refs/heads/{branch}:{local}"),
        ])?;
        transport.run(["rev-parse", "--verify", &format!("{local}^{{commit}}")])
    }

    /// A fresh private git directory for one network command: mode 0700 under the temporary
    /// directory, created new, with no template, so it holds only the config `git init` writes.
    fn transport(&self) -> Result<Transport<'_>, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let mut last = String::new();
        for _ in 0..8 {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "reverie-publish-transport-{}-{nanos:x}-{n}",
                std::process::id()
            ));
            match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
                Ok(()) => return Transport { git: self, dir }.init(),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last = e.to_string(),
                Err(e) => return Err(format!("transport directory: {e}")),
            }
        }
        Err(format!("transport directory: {last}"))
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
        // What was imported must be exactly what the sealed bundle lists.
        let listed: BTreeSet<String> = self
            .run(["bundle", "list-heads", &bundle])?
            .lines()
            .filter_map(|line| {
                let (id, name) = line.split_once(' ')?;
                Some(format!("{id} {prefix}{}", name.strip_prefix("refs/")?))
            })
            .collect();
        let imported: BTreeSet<String> = self
            .run(["for-each-ref", "--format=%(objectname) %(refname)", &prefix])?
            .lines()
            .map(str::to_owned)
            .collect();
        if listed.is_empty() || listed != imported {
            return Err("the imported refs are not exactly the sealed bundle's".into());
        }
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

/// A private git directory that network commands use instead of the store's: git reads its
/// fresh config, never the store's, while objects are still read from and written to the store
/// (`GIT_OBJECT_DIRECTORY`, relative to the held store git starts in). Removed when dropped.
struct Transport<'g> {
    git: &'g Git,
    dir: PathBuf,
}

impl Transport<'_> {
    /// `git init` with no template, so the directory holds only the config it writes. On
    /// failure the directory is dropped, which removes it.
    fn init(self) -> Result<Self, String> {
        let init = self
            .git
            .command_in(
                self.dir.as_os_str(),
                ["init", "--quiet", "--bare", "--template="],
            )
            .output()
            .map_err(|e| format!("could not run git: {e}"))?;
        if !init.status.success() {
            return Err(format!(
                "git init failed: {}",
                String::from_utf8_lossy(&init.stderr).trim()
            ));
        }
        Ok(self)
    }

    fn command<I, S>(&self, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut command = self.git.command_in(self.dir.as_os_str(), args);
        command.env("GIT_OBJECT_DIRECTORY", "objects");
        command
    }

    fn run<I, S>(&self, args: I) -> Result<String, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = self
            .command(args)
            .output()
            .map_err(|e| format!("could not run git: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "git failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end_matches('\n')
            .to_owned())
    }
}

impl Drop for Transport<'_> {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A bare store holding one blob with `marker` as its content; returns the blob's id.
    fn init(path: &Path, marker: &str) -> String {
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .arg("--git-dir")
                .arg(path)
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success());
            String::from_utf8_lossy(&out.stdout).trim().to_owned()
        };
        git(&["init", "-q", "--bare"]);
        let file = path.join("marker");
        fs::write(&file, marker).unwrap();
        let id = git(&["hash-object", "-w", file.to_str().unwrap()]);
        fs::remove_file(file).unwrap();
        id
    }

    #[test]
    fn git_keeps_working_in_the_held_store_after_its_path_is_swapped() {
        let root = std::env::temp_dir().join(format!("publish-git-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let held = init(&root.join("store.git"), "held");
        let git = Git::open(&root.join("store.git")).unwrap();
        fs::rename(root.join("store.git"), root.join("store-moved.git")).unwrap();
        let substituted = init(&root.join("store.git"), "substituted");
        assert_eq!(git.run(["cat-file", "blob", &held]).unwrap(), "held");
        assert!(git.run(["cat-file", "-e", &substituted]).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn git_reads_no_system_or_user_attributes() {
        let root = std::env::temp_dir().join(format!("publish-git-attrs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        init(&root.join("store.git"), "held");
        let git = Git::open(&root.join("store.git")).unwrap();
        let command = git.command(["status"]);
        let envs: Vec<_> = command.get_envs().collect();
        let set = |key: &str| {
            envs.iter()
                .find(|(k, _)| *k == OsStr::new(key))
                .map(|(_, v)| *v)
        };
        assert_eq!(set("GIT_ATTR_NOSYSTEM"), Some(Some(OsStr::new("1"))));
        assert_eq!(set("XDG_CONFIG_HOME"), Some(None));
        assert_eq!(set("HOME"), Some(Some(git.private.0.as_os_str())));
        assert!(
            command
                .get_args()
                .any(|a| a == "core.attributesFile=/dev/null")
        );
        drop(git);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_store_config_is_never_read() {
        let root = std::env::temp_dir().join(format!("publish-git-config-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        init(&root.join("store.git"), "held");
        let status = Command::new("git")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args(["--git-dir", root.join("store.git").to_str().unwrap()])
            .args(["config", "publish.marker", "store"])
            .status()
            .unwrap();
        assert!(status.success());
        let git = Git::open(&root.join("store.git")).unwrap();
        assert!(git.run(["config", "publish.marker"]).is_err());
        let private = git.private.0.clone();
        assert!(private.join("config").is_file());
        drop(git);
        assert!(!private.exists());
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
