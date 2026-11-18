//! Prepare Hands vision parts with the Office authority for scoped employees.
mod local;
#[cfg(test)]
mod tests;

use crate::{capture::Signals, hands_settings::truthy, scoped_image};
use base64::{Engine, engine::general_purpose::STANDARD};
use reverie_core::ids::ChatRoomId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    env,
    io::{self, BufWriter, Write},
    path::{Path, PathBuf},
};

const ATTACHMENT_LIMIT: usize = 20;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    settings: Settings,
    room: String,
    message: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    vision: bool,
    root: Option<PathBuf>,
    session: Option<String>,
    cli: Vec<String>,
    max_images: usize,
    max_bytes: u64,
    timeout: f64,
}

#[derive(Serialize, Default)]
struct Reply {
    parts: Vec<Value>,
    notes: Vec<String>,
    failures: Vec<(String, String)>,
}

#[derive(Clone, Copy)]
enum Mode<'a> {
    Disabled,
    Shared(&'a Path),
    Scoped(Option<&'a str>),
}

fn mode<'a>(settings: &'a Settings, scoped: bool, session: Option<&'a str>) -> Mode<'a> {
    if !settings.vision {
        return Mode::Disabled;
    }
    if scoped {
        return Mode::Scoped(session);
    }
    match settings
        .root
        .as_deref()
        .filter(|root| !root.as_os_str().is_empty())
    {
        Some(root) => Mode::Shared(root),
        None => Mode::Disabled,
    }
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let signals = scoped_image::bind_download_worker(parent)?;
    let data = crate::bounded_input(crate::TURN_CAPTURE_BOUND)?;
    let request: Request = serde_json::from_slice(&data)?;
    let session = env::var("REVERIE_SESSION_ID").ok();
    let scoped = env::var("REVERIE_WORKER").as_deref() == Ok("1");
    let mode = mode(&request.settings, scoped, session.as_deref());
    let reply = request.collect(mode, |file| {
        signals.check()?;
        request.read(mode, file, Path::new("/scratch/tmp"), &signals)
    })?;
    // Keep the existing independent image budgets. A single text-frame ceiling
    // on the aggregate base64 would refuse otherwise allowed images.
    let mut output = BufWriter::new(io::stdout().lock());
    serde_json::to_writer(&mut output, &reply)?;
    output.flush()
}

impl Request {
    fn room(&self) -> &str {
        let quoted = self.message["roomId"].as_str().unwrap_or_default();
        if quoted.starts_with(&self.room) && ChatRoomId::parse(quoted).is_ok() {
            quoted
        } else {
            &self.room
        }
    }

    fn read(
        &self,
        mode: Mode<'_>,
        file: &Value,
        scratch: &Path,
        signals: &Signals,
    ) -> io::Result<Vec<u8>> {
        let config = &self.settings;
        match mode {
            Mode::Disabled => Err(crate::refused()),
            Mode::Shared(root) => local::read(
                root,
                self.room(),
                Path::new(file["path"].as_str().ok_or_else(crate::refused)?),
                config.max_bytes,
            ),
            Mode::Scoped(session) => scoped_image::Request {
                cli: config.cli.clone(),
                session: config.session.clone().unwrap_or_default(),
                room: self.room().to_owned(),
                attachment: file["id"].as_str().unwrap_or_default().to_owned(),
                max_bytes: config.max_bytes,
                timeout: config.timeout,
            }
            .authorize(Some("1"), session)?
            .fetch(scratch, signals),
        }
    }

    fn collect(
        &self,
        mode: Mode<'_>,
        mut read: impl FnMut(&Value) -> io::Result<Vec<u8>>,
    ) -> io::Result<Reply> {
        let mut reply = Reply::default();
        let Some(attachments) = self.message["attachments"].as_array() else {
            return Ok(reply);
        };
        for file in attachments.iter().take(ATTACHMENT_LIMIT) {
            let Some(mime) = file["type"].as_str().and_then(ImageType::parse) else {
                continue;
            };
            let name = name(&file["name"]);
            if matches!(mode, Mode::Disabled) {
                reply
                    .notes
                    .push(format!("[image {name}: you cannot see images yet]"));
            } else if reply.parts.len() >= self.settings.max_images {
                let limit = self.settings.max_images;
                reply
                    .notes
                    .push(format!("[image {name}: skipped, more than {limit} images]"));
            } else {
                self.append(&mut reply, mime, name, read(file))?;
            }
        }
        Ok(reply)
    }

    fn append(
        &self,
        reply: &mut Reply,
        mime: ImageType,
        name: String,
        data: io::Result<Vec<u8>>,
    ) -> io::Result<()> {
        let result = data.and_then(|bytes| {
            if bytes.len() as u64 > self.settings.max_bytes {
                return Err(io::Error::other("too large"));
            }
            if !mime.matches(&bytes) {
                return Err(io::Error::other(format!(
                    "content does not match {}",
                    mime.name()
                )));
            }
            let url = format!("data:{};base64,{}", mime.name(), STANDARD.encode(&bytes));
            Ok(json!({ "type": "image_url", "image_url": { "url": url } }))
        });
        match result {
            Ok(part) => reply.parts.push(part),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => return Err(error),
            Err(error) => {
                reply
                    .notes
                    .push(format!("[image {name}: could not be read]"));
                reply
                    .failures
                    .push((name, error.to_string().chars().take(200).collect()));
            }
        }
        Ok(())
    }
}

fn name(value: &Value) -> String {
    match value {
        _ if !truthy(value) => "file".to_owned(),
        Value::String(text) => text.chars().take(80).collect(),
        Value::Bool(true) => "True".to_owned(),
        _ => value.to_string().chars().take(80).collect(),
    }
}

#[derive(Clone, Copy)]
enum ImageType {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl ImageType {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "image/png" => Some(Self::Png),
            "image/jpeg" => Some(Self::Jpeg),
            "image/gif" => Some(Self::Gif),
            "image/webp" => Some(Self::Webp),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }

    fn matches(self, bytes: &[u8]) -> bool {
        match self {
            Self::Png => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            Self::Jpeg => bytes.starts_with(b"\xff\xd8\xff"),
            Self::Gif => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
            Self::Webp => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        }
    }
}
