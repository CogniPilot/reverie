use reverie_contracts::hands_web::validate_settings;
use serde_json::{Map, Value};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

const CURL: &str = match option_env!("REVERIE_FIXED_HANDS_SEARCH_CURL") {
    Some(path) => path,
    None => "curl",
};
const QUERY_CHARS: usize = 300;
const STATUS_BYTES: usize = 3;

pub(super) struct Search<'a> {
    base: &'a str,
    query: &'a str,
    results: usize,
    timeout: Duration,
    max_bytes: usize,
}

impl<'a> Search<'a> {
    pub(super) fn new(query: &'a str, settings: &'a Map<String, Value>) -> Option<Self> {
        validate_settings(settings).ok()?;
        if query.trim().is_empty()
            || query.chars().count() > QUERY_CHARS
            || query.chars().any(char::is_control)
        {
            return None;
        }
        let number = |key| settings.get(key)?.as_u64();
        Some(Self {
            base: settings.get("search_url")?.as_str()?,
            query,
            results: number("search_results")?.try_into().ok()?,
            timeout: Duration::from_secs(number("search_timeout_s")?),
            max_bytes: number("search_max_bytes")?.try_into().ok()?,
        })
    }

    pub(super) fn timeout(&self) -> Duration {
        self.timeout
    }

    pub(super) async fn run(&self) -> Option<String> {
        let mut child = self.command().spawn().ok()?;
        let mut input = child.stdin.take()?;
        input.write_all(self.query.as_bytes()).await.ok()?;
        drop(input);
        let limit = self.max_bytes + STATUS_BYTES;
        let mut raw = Vec::new();
        child
            .stdout
            .take()?
            .take((limit + 1) as u64)
            .read_to_end(&mut raw)
            .await
            .ok()?;
        if raw.len() > limit || !child.wait().await.ok()?.success() {
            return None;
        }
        let (body, status) = raw.split_at(raw.len().checked_sub(STATUS_BYTES)?);
        if !status.starts_with(b"2") {
            return None;
        }
        render(&serde_json::from_slice(body).ok()?, self.results)
    }

    fn command(&self) -> Command {
        let base = self.base.trim_end_matches(['#', '?']).trim_end_matches('/');
        let url = format!("{base}/search");
        let mut command = Command::new(CURL);
        // The owner chooses this service. An agent supplies only the encoded q value.
        command
            .args([
                "-q",
                "--silent",
                "--globoff",
                "--location",
                "--max-redirs",
                "10",
                "--proto",
                "=http,https",
                "--proto-redir",
                "=http,https",
                "--disallow-username-in-url",
                "--max-time",
                &self.timeout.as_secs().to_string(),
                "--max-filesize",
                &self.max_bytes.to_string(),
                "--header",
                "Accept: application/json",
                "--url-query",
                "q@-",
                "--url-query",
                "format=json",
                "--write-out",
                "%{http_code}",
                "--url",
                &url,
            ])
            .env_remove("ALL_PROXY")
            .env_remove("all_proxy")
            .env_remove("SSLKEYLOGFILE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // urllib accepts uppercase HTTP_PROXY outside CGI. curl intentionally reads the lowercase form.
        if std::env::var_os("http_proxy").is_none()
            && std::env::var_os("REQUEST_METHOD").is_none()
            && let Some(proxy) = std::env::var_os("HTTP_PROXY")
        {
            command.env("http_proxy", proxy);
        }
        command
    }
}

fn render(data: &Value, limit: usize) -> Option<String> {
    let results = data.as_object()?.get("results").filter(|v| !v.is_null());
    let Some(results) = results else {
        return Some("(no results)".into());
    };
    let mut lines = Vec::new();
    for item in results.as_array()?.iter().take(limit) {
        let item = item.as_object()?;
        let text = |key, cap| {
            item.get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .chars()
                .take(cap)
                .collect::<String>()
        };
        let (title, link, snippet) = (text("title", 200), text("url", 300), text("content", 500));
        lines.push(format!("- {title} <{link}>\n  {snippet}"));
    }
    Some(if lines.is_empty() {
        "(no results)".into()
    } else {
        lines.join("\n")
    })
}

#[cfg(test)]
mod tests;
