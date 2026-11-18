use crate::hands_settings::truthy;
use reverie_core::ids::ChatMessageId;
use serde_json::Value;
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};

pub(super) fn chars(text: &str) -> usize {
    text.chars().count()
}

pub(super) fn frame(text: &str) -> String {
    let mut characters = text.chars().peekable();
    let mut output = String::new();
    while let Some(character) = characters.next() {
        if character == '\r' {
            characters.next_if_eq(&'\n');
        }
        if matches!(
            character,
            '\n' | '\r' | '\x0b' | '\x0c' | '\x1c'..='\x1e' | '\u{85}' | '\u{2028}' | '\u{2029}'
        ) {
            output.push_str("\n  ");
        } else {
            output.push(character);
        }
    }
    output
}

pub(super) fn stamp(time: Option<&str>, text: &str) -> String {
    time.map_or_else(|| text.to_owned(), |time| format!("[{time}] {text}"))
}

pub(super) fn tag(id: &Value) -> String {
    id.as_str()
        .and_then(|id| ChatMessageId::parse(id).ok())
        .map_or_else(String::new, |id| format!("[msg {id}] "))
}

pub(super) fn speaker(row: &Value) -> String {
    let sender = &row["from"];
    let name = sender["name"].as_str().filter(|name| !name.is_empty());
    if sender["kind"].as_str() == Some("user") {
        format!("{} (owner)", name.unwrap_or("Owner"))
    } else {
        name.unwrap_or("someone").to_owned()
    }
}

fn omission(missing: usize) -> String {
    format!(" [... {missing} more characters of this message are not shown]")
}

pub(super) fn trim_message(text: &str, cap: usize) -> String {
    let len = chars(text);
    if len <= cap {
        return text.to_owned();
    }
    let keep = cap.saturating_sub(omission(len).len());
    let mut result: String = text.chars().take(keep).collect();
    result.push_str(&omission(len - keep));
    result
}

pub(super) fn attachment_note(row: &Value) -> String {
    let Some(files) = row["attachments"].as_array() else {
        return String::new();
    };
    let names: Vec<String> = files
        .iter()
        .take(5)
        .filter(|file| file.is_object())
        .map(|file| {
            let name = &file["name"];
            match name {
                _ if !truthy(name) => "file".into(),
                Value::String(name) => name.chars().take(80).collect(),
                Value::Bool(true) => "True".into(),
                _ => name.to_string().chars().take(80).collect(),
            }
        })
        .collect();
    if names.is_empty() {
        String::new()
    } else {
        format!(" [attached: {}]", names.join(", "))
    }
}

pub(super) fn file_tail(path: Option<&Path>, cap: usize, prompt_cap: usize) -> io::Result<String> {
    let Some(path) = path.filter(|path| !path.as_os_str().is_empty()) else {
        return Ok(String::new());
    };
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error),
    };
    // Legacy zero means all text. Reading beyond the prompt cap can only refuse the prompt.
    let limit = prompt_cap.saturating_add(1);
    let cap = if cap == 0 { limit } else { cap.min(limit) };
    // Each output scalar represents at most four source bytes, including CRLF and replacement.
    let byte_cap = cap
        .saturating_mul(4)
        .saturating_add(4)
        .min(crate::TURN_CAPTURE_BOUND) as u64;
    let length = file.metadata()?.len();
    if length > byte_cap {
        file.seek(SeekFrom::Start(length - byte_cap))?;
    }
    let mut bytes = Vec::new();
    file.take(byte_cap).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let skip = chars(&text).saturating_sub(cap);
    Ok(text.chars().skip(skip).collect())
}
