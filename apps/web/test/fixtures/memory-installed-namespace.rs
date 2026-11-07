//! Test-only namespace fixture; never packaged or exposed as an operator tool.
//! The parent owns this synthetic root and the exact selected memory ELF copy.
//! Public Nix artifacts are readonly; no host data/engine/admin mount is used.
use std::{
    io::{self, Read, Write},
    path::Path,
    process::{Command, Output, Stdio},
};

fn checked(command: &mut Command) {
    let output = command.output().unwrap();
    assert!(output.status.success(), "{command:?}: {output:?}");
}

fn native(root: &Path, arguments: &[&str], input: Option<&[u8]>) -> Output {
    let mut child = Command::new("chroot")
        .arg(root)
        .arg("/bin/reverie-memory")
        .args(arguments)
        .env_clear()
        .env("HOME", "/home/test")
        .env("REVERIE_ROOT", "/home/test/.reverie")
        .env("REVERIE_EMBED_DIMS", "8")
        .env("REVERIE_API_BASE", "http://127.0.0.1:0")
        .env("REVERIE_EMBED_URL", "http://127.0.0.1:0")
        .env("REVERIE_EMBED_QUERY_PREFIX", "chosen-query: ")
        .env("REVERIE_EMBED_DOC_PREFIX", "chosen-document: ")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(input) = input {
        child.stdin.take().unwrap().write_all(input).unwrap();
    }
    drop(child.stdin.take());
    child.wait_with_output().unwrap()
}

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    assert_eq!(args.len(), 4);
    let root = Path::new(&args[1]);
    let guest_configuration = &args[2];
    let fingerprint = &args[3];
    checked(
        Command::new("mount")
            .args(["--bind", "/nix/store"])
            .arg(root.join("nix/store")),
    );
    checked(
        Command::new("mount")
            .args(["-o", "remount,bind,ro"])
            .arg(root.join("nix/store")),
    );
    // Explicit fixture setup is separate from the actual read request. Ready
    // synchronizes setup only; the real API still decides the subsequent use.
    let initialized = native(
        root,
        &["--initialize", "--instance", guest_configuration],
        None,
    );
    assert!(
        initialized.status.success(),
        "explicit fixture startup: {initialized:?}"
    );
    println!("READY");
    io::stdout().flush().unwrap();
    let mut body = Vec::new();
    io::stdin()
        .take(32 * 1024 + 1)
        .read_to_end(&mut body)
        .unwrap();
    assert!(body.len() <= 32 * 1024);
    if body.is_empty() {
        return;
    }
    let output = native(
        root,
        &["--installed-context", "--expected-context", fingerprint],
        Some(&body),
    );
    let code = output.status.code().unwrap_or(1);
    println!(
        "RESULT {code} {} {}",
        output.stdout.len(),
        output.stderr.len()
    );
    io::stdout().write_all(&output.stdout).unwrap();
    io::stdout().write_all(&output.stderr).unwrap();
    io::stdout().flush().unwrap();
}
