//! `git` with explicit argv against one object store, no shell, no credential helper, no hooks,
//! no replacement objects, no user or system config, and no `GIT_*` variable from the caller: any
//! of them could redirect, reconfigure (`GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS`), trace or run
//! code inside git. The object store is held (see `custody`): git starts inside the held directory
//! with its objects there, so a symlink on the store's path is refused and a swap of the path later
//! cannot point git at another store.
//!
//! git never reads the store's own config, attributes or refs either: every command runs against a
//! fresh private git directory (`Private`) whose only config is what `git init` writes, with the
//! store's objects (`GIT_OBJECT_DIRECTORY`). A `url.*.insteadOf`, `protocol.*`, `core.attributesFile`,
//! merge driver or `include.path` placed in the store therefore changes nothing a check or fetch
//! does.
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
            .base_command()
            .arg("--git-dir")
            .arg(&git.private.0)
            .args(["init", "--quiet", "--bare", "--template="])
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
        let mut command = self.base_command();
        command
            .arg("--git-dir")
            .arg(&self.private.0)
            // Relative to the held store git starts in.
            .env("GIT_OBJECT_DIRECTORY", "objects")
            .args(args);
        command
    }

    /// git started inside the held store with the scrubbed environment and no repository yet.
    fn base_command(&self) -> Command {
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
            .current_dir(self.store.proc_path());
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
}
