//! Opt-in telemetry carries a fixed alias and exit, without raw command fields.
use reverie_core::{command_telemetry::FailureExit, worker_options::TelemetryKey};
use serde_json::json;
use std::{
    io::{self, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    time::{Duration, Instant},
};
use uuid::Builder;

const OFFICE_RELAY: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8093);
const BUDGET: Duration = Duration::from_millis(50);

fn tool(executable: &str) -> &'static str {
    match executable {
        "bash" | "/bin/bash" | "sh" | "/bin/sh" => TelemetryKey::Shell.as_str(),
        "python" | "python3" | "/bin/python" | "/bin/python3" => TelemetryKey::Python.as_str(),
        "git" | "/bin/git" => TelemetryKey::Git.as_str(),
        "zip" | "/bin/zip" => TelemetryKey::Zip.as_str(),
        _ => "UNKNOWN_COMMAND",
    }
}

pub(crate) fn observe(enabled: bool, executable: &str, exit: i32) {
    if enabled && let Some(code) = i16::try_from(exit).ok().and_then(FailureExit::try_new) {
        let _ = report(OFFICE_RELAY, executable, code);
    }
}

fn packet(executable: &str, exit: FailureExit) -> io::Result<String> {
    let mut bytes = [0; 16];
    getrandom::getrandom(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    let id = Builder::from_random_bytes(bytes).into_uuid();
    let body = json!({"v": 1, "execution_id": id.to_string(), "tool": tool(executable), "exit_code": exit.get()}).to_string();
    Ok(format!(
        "POST /api/command-telemetry/hands HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    ))
}

fn report(address: SocketAddr, executable: &str, exit: FailureExit) -> io::Result<()> {
    let packet = packet(executable, exit)?;
    let deadline = Instant::now() + BUDGET;
    let mut stream = TcpStream::connect_timeout(&address, remaining(deadline)?)?;
    send(&mut stream, packet.as_bytes(), deadline)?;
    response(&mut stream, deadline)
}

fn remaining(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|time| !time.is_zero())
        .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))
}

fn send(stream: &mut TcpStream, mut request: &[u8], deadline: Instant) -> io::Result<()> {
    while !request.is_empty() {
        stream.set_write_timeout(Some(remaining(deadline)?))?;
        let written = stream.write(request)?;
        if written == 0 {
            return Err(io::Error::from(io::ErrorKind::WriteZero));
        }
        request = &request[written..];
    }
    Ok(())
}

fn response(stream: &mut TcpStream, deadline: Instant) -> io::Result<()> {
    let mut buffer = [0; 1024];
    let mut size = 0;
    while size < buffer.len() {
        stream.set_read_timeout(Some(remaining(deadline)?))?;
        let count = stream.read(&mut buffer[size..])?;
        size += count;
        if count == 0 || buffer[..size].windows(4).any(|part| part == b"\r\n\r\n") {
            break;
        }
    }
    remaining(deadline)?;
    if [
        b"HTTP/1.0 204 No Content\r\n",
        b"HTTP/1.1 204 No Content\r\n",
    ]
    .iter()
    .any(|status| buffer[..size].starts_with(*status))
    {
        Ok(())
    } else {
        Err(io::Error::other("command telemetry refused"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::net::TcpListener;

    #[test]
    fn only_fixed_alias_and_fresh_execution_are_sent_to_the_phone() {
        let failure = FailureExit::try_new(127).unwrap();
        for (program, key) in [
            ("/private/synthetic-credential", "UNKNOWN_COMMAND"),
            ("/bin/bash", "shell"),
            ("python3", "python"),
            ("git", "git"),
            ("zip", "zip"),
        ] {
            let sent = packet(program, failure).unwrap();
            assert!(sent.starts_with("POST /api/command-telemetry/hands HTTP/1.1\r\n"));
            let (headers, body) = sent.split_once("\r\n\r\n").unwrap();
            assert!(headers.ends_with(&format!("Content-Length: {}", body.len())));
            assert!(!sent.contains("/private/"));
            let event: Value = serde_json::from_str(body).unwrap();
            assert_eq!(event.as_object().unwrap().len(), 4);
            assert_eq!(event["v"], 1);
            assert_eq!(event["tool"], key);
            assert_eq!(event["exit_code"], 127);
            assert!(uuid::Uuid::parse_str(event["execution_id"].as_str().unwrap()).is_ok());
            assert_ne!(sent, packet(program, failure).unwrap());
        }
    }

    #[test]
    fn unavailable_phone_is_a_bounded_best_effort_effect() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let started = Instant::now();
        let error = report(address, "zip", FailureExit::try_new(7).unwrap()).unwrap_err();
        assert!(matches!(
            error.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        ));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
