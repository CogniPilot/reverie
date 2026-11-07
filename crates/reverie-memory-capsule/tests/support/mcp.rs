use std::{
    io::{BufRead, Read, Write},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};
/// Actual MCP client: handshake and await each requested reply before sending
/// EOF. EOF intentionally cancels unfinished real work in the installed entry.
pub(super) fn run(command: &mut Command, frames: &[serde_json::Value], budget: Duration) -> Output {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let (sent, replies) = std::sync::mpsc::channel();
    let output = thread::spawn(move || mcp_output(stdout, sent));
    let diagnostics = thread::spawn(move || {
        let mut raw = Vec::new();
        stderr.read_to_end(&mut raw).unwrap();
        raw
    });
    let end = Instant::now() + budget;
    let exchanged = exchange(&mut input, frames, &replies, end);
    drop(input);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if exchanged.is_err() || Instant::now() >= end {
            let _ = child.kill();
            break child.wait().unwrap();
        }
        thread::sleep(Duration::from_millis(10));
    };
    let stdout = output.join().unwrap();
    let stderr = diagnostics.join().unwrap();
    assert!(
        exchanged.is_ok(),
        "actual MCP exchange {exchanged:?}; stderr {}",
        String::from_utf8_lossy(&stderr)
    );
    assert!(
        Instant::now() < end,
        "MCP must settle after replies and EOF"
    );
    Output {
        status,
        stdout,
        stderr,
    }
}
fn mcp_output(stdout: std::process::ChildStdout, replies: std::sync::mpsc::Sender<u64>) -> Vec<u8> {
    let mut reader = std::io::BufReader::new(stdout);
    let mut result = Vec::new();
    loop {
        let mut line = Vec::new();
        if reader.read_until(b'\n', &mut line).unwrap() == 0 {
            break;
        }
        result.extend_from_slice(&line);
        assert!(
            result.len() <= 1024 * 1024,
            "bounded owned protocol fixture"
        );
        let value: serde_json::Value = serde_json::from_slice(&line).unwrap();
        if let Some(id) = value["id"].as_u64() {
            let _ = replies.send(id);
        }
    }
    result
}
fn exchange(
    input: &mut std::process::ChildStdin,
    frames: &[serde_json::Value],
    replies: &std::sync::mpsc::Receiver<u64>,
    end: Instant,
) -> Result<(), String> {
    for frame in frames {
        let mut bytes = serde_json::to_vec(frame).unwrap();
        bytes.push(b'\n');
        assert!(bytes.len() < 4096, "one owned frame fits the stdin pipe");
        input.write_all(&bytes).map_err(|e| e.to_string())?;
        if let Some(expected) = frame["id"].as_u64() {
            let actual = replies
                .recv_timeout(end.saturating_duration_since(Instant::now()))
                .map_err(|e| e.to_string())?;
            if actual != expected {
                return Err(format!(
                    "expected actual response {expected}, received {actual}"
                ));
            }
        }
    }
    Ok(())
}
