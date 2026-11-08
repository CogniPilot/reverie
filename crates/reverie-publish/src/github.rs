//! GitHub REST calls through `curl`. The token never appears in argv or in the environment: curl
//! reads its whole configuration, Authorization header included, from stdin (`--config -`), and a
//! request body comes from a private temporary file named in that configuration.
use serde_json::Value;
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const API: &str = "https://api.github.com";

/// How a request reaches GitHub; the curl transport in use, a fake in tests.
pub trait Transport {
    /// Sends `method path` with an optional JSON body and returns the HTTP status and body.
    fn send(&self, method: &str, path: &str, body: Option<&Value>)
    -> Result<(u16, String), String>;
}

#[derive(Debug)]
pub struct Curl {
    token_file: PathBuf,
    scratch: PathBuf,
}

impl Curl {
    /// `token_file` holds only the token; `scratch` is a private directory for request bodies.
    pub fn new(token_file: &Path, scratch: &Path) -> Self {
        Self {
            token_file: token_file.to_path_buf(),
            scratch: scratch.to_path_buf(),
        }
    }
}

/// The curl configuration for one request, as written to curl's stdin.
pub fn config(
    method: &str,
    url: &str,
    token: &str,
    body_file: Option<&Path>,
) -> Result<String, String> {
    let quote = |value: &str| -> Result<String, String> {
        if value
            .chars()
            .any(|c| c == '"' || c == '\\' || c.is_control())
        {
            return Err("a curl config value holds a quote, backslash or control character".into());
        }
        Ok(format!("\"{value}\""))
    };
    let mut lines = vec![
        format!("url = {}", quote(url)?),
        format!("request = {}", quote(method)?),
        format!(
            "header = {}",
            quote(&format!("Authorization: Bearer {token}"))?
        ),
        format!("header = {}", quote("Accept: application/vnd.github+json")?),
        format!("header = {}", quote("X-GitHub-Api-Version: 2022-11-28")?),
        format!("user-agent = {}", quote("reverie-publish")?),
        "silent".into(),
        "show-error".into(),
        "write-out = \"\\n%{http_code}\"".into(),
        "max-time = 60".into(),
    ];
    if let Some(file) = body_file {
        lines.push(format!(
            "header = {}",
            quote("Content-Type: application/json")?
        ));
        lines.push(format!(
            "data-binary = {}",
            quote(&format!("@{}", file.display()))?
        ));
    }
    Ok(lines.join("\n") + "\n")
}

impl Transport for Curl {
    fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<(u16, String), String> {
        let token = std::fs::read_to_string(&self.token_file)
            .map_err(|e| format!("token file: {}", e.kind()))?;
        let token = token.trim();
        if token.is_empty() || token.contains(char::is_whitespace) {
            return Err("the token file must hold one token".into());
        }
        let body_file = match body {
            None => None,
            Some(value) => {
                let path = self
                    .scratch
                    .join(format!("request-{}.json", std::process::id()));
                write_private(&path, value.to_string().as_bytes())?;
                Some(path)
            }
        };
        let config = config(method, &format!("{API}{path}"), token, body_file.as_deref())?;
        let result = run_curl(&config);
        if let Some(path) = body_file {
            let _ = std::fs::remove_file(path);
        }
        let output = result?;
        let (body, status) = output.rsplit_once('\n').ok_or("curl printed no status")?;
        let status = status
            .trim()
            .parse()
            .map_err(|_| "curl printed no status")?;
        Ok((status, body.to_owned()))
    }
}

fn run_curl(config: &str) -> Result<String, String> {
    let mut child = Command::new("curl")
        .args(["--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run curl: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("curl has no stdin")?
        .write_all(config.as_bytes())
        .map_err(|e| format!("curl stdin: {e}"))?;
    let output = child.wait_with_output().map_err(|e| format!("curl: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "curl failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    String::from_utf8(output.stdout).map_err(|_| "curl output is not UTF-8".into())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    file.write_all(bytes)
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// One repository's API, over a transport.
pub struct Repo<'a> {
    pub transport: &'a dyn Transport,
    /// `OWNER/NAME`.
    pub name: String,
}

impl Repo<'_> {
    /// Sends a request under `/repos/OWNER/NAME` and parses the JSON reply; any status outside
    /// 200-299 is an error carrying GitHub's message.
    pub fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let (status, text) =
            self.transport
                .send(method, &format!("/repos/{}{path}", self.name), body)?;
        let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("no message");
            return Err(format!("GitHub {method} {path}: {status} {message}"));
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_goes_only_into_the_stdin_config() {
        let text = config(
            "PATCH",
            "https://api.github.com/repos/o/r/pulls/1",
            "tok123",
            Some(Path::new("/tmp/b.json")),
        )
        .unwrap();
        assert!(text.contains("header = \"Authorization: Bearer tok123\""));
        assert!(text.contains("request = \"PATCH\""));
        assert!(text.contains("data-binary = \"@/tmp/b.json\""));
    }

    #[test]
    fn a_value_that_could_break_out_of_the_config_is_refused() {
        assert!(config("GET", "https://x/\"\nurl = \"https://evil", "t", None).is_err());
        assert!(config("GET", "https://x", "t\"", None).is_err());
    }
}
