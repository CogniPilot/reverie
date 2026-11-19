//! Evaluate the real Nix packaging rules against disposable checkout fixtures.
#[cfg(target_os = "linux")]
mod console;

use crate::support::{TestDir, fixture_commit, git, workspace_root};
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::{self, ErrorKind},
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};

const ROOT: &str = "builtins.toPath (builtins.getEnv \"REVERIE_SOURCE_AUDIT_ROOT\")";
const INPUT: &str = "builtins.toPath (builtins.getEnv \"REVERIE_SOURCE_AUDIT_NIXPKGS\")";
const FIXTURE: &str = "builtins.toPath (builtins.getEnv \"REVERIE_SOURCE_AUDIT_FIXTURE\")";

struct IndexEntry<'a> {
    path: &'a str,
    kind: &'static str,
}

fn index_entry(entry: &str) -> IndexEntry<'_> {
    let (metadata, path) = entry.split_once('\t').expect("Git stage metadata and path");
    let mut fields = metadata.split_whitespace();
    let kind = match fields.next() {
        Some("100644" | "100755") => "regular",
        Some("120000") => "symlink",
        other => panic!("unsupported Git index mode {other:?} for {path:?}"),
    };
    assert_eq!(
        fields.nth(1),
        Some("0"),
        "unmerged Git index entry {path:?}"
    );
    IndexEntry { path, kind }
}

fn index(root: &Path) -> Option<String> {
    let reported = git(root, &["rev-parse", "--show-toplevel"]);
    if !reported.status.success()
        || Path::new(String::from_utf8_lossy(&reported.stdout).trim())
            .canonicalize()
            .ok()
            .as_deref()
            != Some(root)
    {
        eprintln!("source-filter Git index check requires the repository's own checkout");
        return None;
    }
    let output = git(root, &["ls-files", "--stage", "-z"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Some(String::from_utf8(output.stdout).expect("UTF-8 repository paths"))
}

struct Nix {
    root: PathBuf,
    input: PathBuf,
}

impl Nix {
    fn available() -> Option<Self> {
        let root = workspace_root();
        static INPUT_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
        let input = INPUT_PATH.get_or_init(|| pinned_input(&root)).clone()?;
        Some(Self { root, input })
    }

    fn eval(&self, result: &str, fixture: &Path) -> Value {
        let expression = format!(
            "let repo = {ROOT}; pkgs = import ({INPUT}) {{}}; fixture = {FIXTURE}; in {result}"
        );
        let mut command = Command::new("nix-instantiate");
        command
            .args([
                "--eval",
                "--strict",
                "--json",
                "--read-write-mode",
                "--expr",
                &expression,
            ])
            .env("REVERIE_SOURCE_AUDIT_ROOT", &self.root)
            .env("REVERIE_SOURCE_AUDIT_NIXPKGS", &self.input)
            .env("REVERIE_SOURCE_AUDIT_FIXTURE", fixture);
        serde_json::from_slice(&checked(command).stdout).expect("JSON Nix audit output")
    }
}

fn pinned_input(root: &Path) -> Option<PathBuf> {
    let expression = format!("(builtins.getFlake (toString ({ROOT}))).inputs.nixpkgs.outPath");
    let mut command = nix();
    command
        .args([
            "eval",
            "--offline",
            "--impure",
            "--raw",
            "--expr",
            &expression,
        ])
        .env("REVERIE_SOURCE_AUDIT_ROOT", root);
    match bounded(&mut command) {
        Ok(output) => Some(PathBuf::from(
            String::from_utf8(checked_output(output).stdout).unwrap(),
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            eprintln!("source-filter checks require Nix on PATH");
            None
        }
        Err(error) => panic!("resolve the locked Nixpkgs input: {error}"),
    }
}

fn nix() -> Command {
    let mut command = Command::new("nix");
    command.args(["--extra-experimental-features", "nix-command flakes"]);
    command
}

fn checked(mut command: Command) -> Output {
    checked_output(bounded(&mut command).unwrap_or_else(|error| panic!("{command:?}: {error}")))
}

fn checked_output(output: Output) -> Output {
    assert!(
        output.status.success(),
        "Nix evaluator exited {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn bounded(command: &mut Command) -> io::Result<Output> {
    let io_root = TestDir::new();
    let out = io_root.path().join("stdout");
    let err = io_root.path().join("stderr");
    let mut child = command
        .stdout(File::create(&out)?)
        .stderr(File::create(&err)?)
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            child.wait()?;
            return Err(io::Error::new(
                ErrorKind::TimedOut,
                fs::read_to_string(&err).unwrap_or_default(),
            ));
        }
        thread::sleep(Duration::from_millis(10));
    };
    Ok(Output {
        status,
        stdout: fs::read(out)?,
        stderr: fs::read(err)?,
    })
}

#[test]
fn actual_filter_policy_preserves_versioned_inputs_and_excludes_generated_files() {
    let Some(nix) = Nix::available() else {
        return;
    };
    let checks = nix.eval(
        "import (repo + \"/tests/source_filter_eval.nix\") { inherit (pkgs) lib; }",
        &nix.root,
    );
    for required in [
        "rustTarget",
        "nestedRustTarget",
        "futureRustTarget",
        "rustSource",
        "rustManifest",
        "rustLock",
        "rustPolicy",
        "similarlyNamedRust",
    ] {
        assert_eq!(checks[required], true, "missing Nix check {required}");
    }
    assert!(
        checks
            .as_object()
            .unwrap()
            .values()
            .all(|passed| passed == true)
    );
}

#[test]
fn source_filter_retains_every_tracked_input_including_symlinks() {
    let Some(nix) = Nix::available() else {
        return;
    };
    let Some(files) = index(&nix.root) else {
        return;
    };
    let index = files
        .split_terminator('\0')
        .map(index_entry)
        .map(|entry| json!({"path":entry.path, "type":entry.kind}))
        .collect::<Vec<_>>();
    assert!(index.len() > 2000, "actual repository index required");
    let temp = TestDir::new();
    temp.write("index.json", serde_json::to_vec(&index).unwrap());
    let dropped = nix.eval(
        r#"let keep = import (repo + "/nix/source-filter-policy.nix") { inherit (pkgs) lib; };
                entries = builtins.fromJSON (builtins.readFile (fixture + "/index.json"));
           in builtins.filter (entry: !(keep entry.path entry.type)) entries"#,
        temp.path(),
    );
    assert_eq!(dropped, json!([]), "tracked inputs excluded by Nix");
}

#[test]
fn generated_files_and_worktree_metadata_do_not_change_the_filtered_snapshot() {
    let Some(nix) = Nix::available() else {
        return;
    };
    let temp = TestDir::new();
    for checkout in ["checkout-a", "checkout-b"] {
        for relative in [
            "crates/example/src/lib.rs",
            ".github/ci/check.mjs",
            "apps/web/src/web/public/gesture/model.task",
        ] {
            temp.write(&format!("{checkout}/{relative}"), "source-input\n");
        }
        symlink(
            "crates/example/src/lib.rs",
            temp.path().join(checkout).join("skill-link"),
        )
        .unwrap();
        temp.write(
            &format!("{checkout}/apps/web/node_modules/pkg/index.js"),
            checkout,
        );
    }
    temp.write("checkout-a/.git/objects", "synthetic Git directory");
    temp.write("checkout-b/.git", "gitdir: /unread/worktree\n");
    let expression = r#"
        let clean = src: import (repo + "/nix/source-filter.nix") { inherit (pkgs) lib; inherit src; };
            a = clean (fixture + "/checkout-a");
            b = clean (fixture + "/checkout-b");
        in {
          equal = toString a == toString b;
          aPath = toString a;
          noGit = !(builtins.pathExists (a + "/.git")) && !(builtins.pathExists (b + "/.git"));
          noJunk = !(builtins.pathExists (a + "/apps/web/node_modules"))
            && !(builtins.pathExists (b + "/apps/web/node_modules"));
          preserved = builtins.readFile (a + "/.github/ci/check.mjs") == "source-input\n"
            && builtins.readFile (a + "/skill-link") == "source-input\n";
        }"#;
    let first = nix.eval(expression, temp.path());
    for check in ["equal", "noGit", "noJunk", "preserved"] {
        assert_eq!(first[check], true, "failed Nix snapshot check {check}");
    }
    temp.write("checkout-b/crates/example/src/lib.rs", "changed-source\n");
    let second = nix.eval(expression, temp.path());
    assert_eq!(second["equal"], false);
    assert_eq!(second["aPath"], first["aPath"]);
}

#[test]
fn flake_does_not_pin_the_raw_repository_root() {
    let text = fs::read_to_string(workspace_root().join("flake.nix")).unwrap();
    for raw in ["src = self;", "${self}"] {
        assert!(!text.contains(raw), "raw Nix repository input {raw}");
    }
    for reference in ["self.packages.", "nixosModules.reverieCollect ="] {
        assert!(
            text.contains(reference),
            "missing public flake output {reference}"
        );
    }
}

#[test]
fn nix_captures_the_git_index_and_supports_exported_sources() {
    if Nix::available().is_none() {
        return;
    }
    let temp = TestDir::new();
    for root in ["git-source", "exported source"] {
        temp.write(
            &format!("{root}/flake.nix"),
            "{ outputs = { self }: {}; }\n",
        );
        temp.write(&format!("{root}/tracked.txt"), "source\n");
    }
    let repo = temp.path().join("git-source");
    fixture_commit(&repo);
    temp.write("git-source/untracked.txt", "not-selected\n");

    let selected = captured(repo.to_str().unwrap());
    assert!(!selected.join(".git").exists());
    assert!(!selected.join("untracked.txt").exists());
    assert_eq!(
        fs::read_to_string(selected.join("tracked.txt")).unwrap(),
        "source\n"
    );

    let raw = captured(&format!("path:{}", repo.display()));
    assert!(raw.join(".git").exists());
    assert!(raw.join("untracked.txt").exists());
    let exported = captured(temp.path().join("exported source").to_str().unwrap());
    assert_eq!(
        fs::read_to_string(exported.join("tracked.txt")).unwrap(),
        "source\n"
    );

    temp.write("git-source/tracked.txt", "dirty-working-tree\n");
    let dirty = captured(repo.to_str().unwrap());
    assert_eq!(
        fs::read_to_string(dirty.join("tracked.txt")).unwrap(),
        "dirty-working-tree\n"
    );
    assert!(git(&repo, &["add", "untracked.txt"]).status.success());
    let staged = captured(repo.to_str().unwrap());
    assert_eq!(
        fs::read_to_string(staged.join("untracked.txt")).unwrap(),
        "not-selected\n"
    );
}

fn captured(reference: &str) -> PathBuf {
    let mut command = nix();
    command.args([
        "flake",
        "metadata",
        "--offline",
        "--no-write-lock-file",
        "--json",
        reference,
    ]);
    let metadata: Value = serde_json::from_slice(&checked(command).stdout).unwrap();
    PathBuf::from(metadata["path"].as_str().expect("captured Nix store path"))
}
