use crate::{
    Error, Result,
    frame::{Connection, Decoder, MAX_FRAME},
    native,
};
use serde_json::{Value, json};
use std::io::Read;

fn allowed_env(key: &str) -> bool {
    reverie_core::worker_launch::EnvironmentKey::parse(key).is_ok()
}

fn environment() -> Result<Value> {
    let mut selected = serde_json::Map::new();
    for (key, value) in std::env::vars_os() {
        // Every allowed name is ASCII. An unrelated non-UTF-8 name cannot
        // match and is ignored, preserving the legacy environment filter.
        let Some(key) = key.to_str() else {
            continue;
        };
        if allowed_env(key) {
            let value = value
                .into_string()
                .map_err(|_| Error("Invalid UTF-8 environment value"))?;
            selected.insert(key.into(), value.into());
        }
    }
    Ok(selected.into())
}
pub(crate) fn run(
    connection: &mut Connection,
    mut request: Value,
    reference: Option<String>,
) -> Result<u8> {
    request["env"] = environment()?;
    let output = native::Output::open()?;
    let terminal = native::Terminal::enter()?;
    let result = launch(connection, request, reference, &output);
    let result = if let Some(code) = native::stopped() {
        Ok(code)
    } else {
        result
    };
    output.finish(terminal.finish(result))
}
fn launch(
    connection: &mut Connection,
    mut request: Value,
    reference: Option<String>,
    output: &native::Output,
) -> Result<u8> {
    let (cols, rows) = native::dimensions();
    request["cols"] = cols.into();
    request["rows"] = rows.into();
    let kind = if reference.is_some() { b'L' } else { b'J' };
    let request = match reference {
        Some(reference) => json!({"reference":reference,"request":request}),
        None => request,
    };
    connection.validate()?;
    let raw = serde_json::to_vec(&request)?;
    connection.send(kind, &raw)?;
    interact(connection, output)
}
fn interact(connection: &mut Connection, output: &native::Output) -> Result<u8> {
    let mut decoder = Decoder::new(MAX_FRAME);
    let mut stdin = std::io::stdin().lock();
    loop {
        if let Some(code) = native::stopped() {
            return Ok(code);
        }
        if native::resized() {
            let (cols, rows) = native::dimensions();
            connection.send(b'R', &serde_json::to_vec(&[cols, rows])?)?;
        }
        let (socket, input) = native::poll_terminal(connection.fd())?;
        if socket && let Some(code) = responses(connection, &mut decoder, output)? {
            return Ok(code);
        }
        if input {
            let mut bytes = [0_u8; 65_536];
            let count = match stdin.read(&mut bytes) {
                Ok(count) => count,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            };
            if count == 0 {
                return Ok(1);
            }
            connection.send(b'I', &bytes[..count])?;
        }
    }
}
fn responses(
    connection: &mut Connection,
    decoder: &mut Decoder,
    output: &native::Output,
) -> Result<Option<u8>> {
    if let Some(code) = native::stopped() {
        return Ok(Some(code));
    }
    let Some(frame) = decoder.next(connection)? else {
        return Ok(None);
    };
    // One bounded frame per turn: a busy broker must not starve stdin or resize.
    match frame.kind {
        b'O' => output.write(&frame.payload)?,
        b'X' => {
            let code: i32 = serde_json::from_slice(&frame.payload)?;
            return Ok(Some(code as u8));
        }
        b'E' => {
            let message = std::str::from_utf8(&frame.payload)
                .map_err(|_| Error("Invalid worker response"))?;
            eprintln!("Reverie worker: {message}");
            return Ok(Some(1));
        }
        _ => return Err(Error("Invalid worker response")),
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::allowed_env;
    #[test]
    fn exact_legacy_environment_allowlist() {
        for key in [
            "LANG",
            "CODEX_X",
            "REVERIE_HANDS_X1_",
            "XDG_STATE_HOME",
            "REVERIE_MUX",
        ] {
            assert!(allowed_env(key), "{key}");
        }
        for key in [
            "PATH",
            "HOME",
            "REVERIE_WORKER_SOCKET",
            "CLAUDE_",
            "CODEX_lower",
            "REVERIE_HANDS_",
            "LC_CTYPE",
            "REVERIE_OWNER_TOKEN",
        ] {
            assert!(!allowed_env(key), "{key}");
        }
    }
}
