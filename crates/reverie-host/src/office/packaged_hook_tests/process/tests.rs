use super::*;
use std::io::Write;

const CHILD: &str = "office::tests::packaged_hooks::process::tests::fixture_child";
fn child(mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--ignored",
            "--exact",
            CHILD,
            "--nocapture",
            "--test-threads=1",
        ])
        .env("REVERIE_OWNED_PROCESS_TEST", mode);
    command
}
#[test]
fn full_stdout_and_stderr_are_drained_before_waiting_for_exit() {
    let output = bounded(
        &mut child("output"),
        Duration::from_secs(5),
        3 * 1024 * 1024,
    )
    .unwrap();
    assert!(output.status.success());
    assert!(output.stdout.len() >= 2 * 1024 * 1024);
    assert!(output.stderr.len() >= 2 * 1024 * 1024);
}
#[test]
fn output_ceiling_refuses_without_waiting_on_a_full_pipe() {
    let started = Instant::now();
    let error = bounded(&mut child("output"), Duration::from_secs(5), 4096).unwrap_err();
    assert!(error.to_string().contains("output limit"));
    assert!(started.elapsed() < Duration::from_secs(3));
}
#[test]
fn exited_parent_with_live_descendant_pipes_has_a_bounded_failure() {
    let started = Instant::now();
    let error = bounded(&mut child("descendant"), Duration::from_millis(200), 4096).unwrap_err();
    assert!(error.to_string().contains("deadline"));
    assert!(started.elapsed() < Duration::from_secs(3));
}
#[test]
#[ignore = "only invoked by the bounded process tests above"]
fn fixture_child() {
    match std::env::var("REVERIE_OWNED_PROCESS_TEST")
        .unwrap()
        .as_str()
    {
        "output" => {
            let bytes = vec![b'x'; 2 * 1024 * 1024];
            std::io::stdout().write_all(&bytes).unwrap();
            std::io::stderr().write_all(&bytes).unwrap();
        }
        "descendant" => {
            let mut descendant = child("hold")
                .stdin(Stdio::null())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
            // The fixture parent exits with this wait still pending. Its child
            // keeps the inherited pipes open, reproducing the original hang.
            std::thread::spawn(move || descendant.wait().unwrap());
        }
        "hold" => std::thread::sleep(Duration::from_secs(30)),
        _ => panic!("unknown owned process fixture mode"),
    }
}
