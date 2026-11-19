use crate::{commands, files, task::Task};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{fmt, io};

#[derive(Debug)]
pub(crate) struct Fault(String);

pub(crate) type Result<T> = std::result::Result<T, Fault>;

impl From<&str> for Fault {
    fn from(value: &str) -> Self {
        Self(value.into())
    }
}
impl From<String> for Fault {
    fn from(value: String) -> Self {
        Self(value)
    }
}
impl From<io::Error> for Fault {
    fn from(value: io::Error) -> Self {
        Self(value.to_string())
    }
}
impl fmt::Display for Fault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Serialize)]
pub(crate) struct Reply {
    version: u8,
    ok: bool,
    output: String,
    error: Option<String>,
    truncated: bool,
    exit_code: Option<i32>,
}

impl Reply {
    pub(crate) fn text(output: String, truncated: bool) -> Self {
        Self {
            version: 1,
            ok: true,
            output,
            error: None,
            truncated,
            exit_code: None,
        }
    }
    pub(crate) fn refused(error: Fault) -> Self {
        Self::command(String::new(), false, Err(error.0))
    }
    pub(crate) fn command(
        output: String,
        truncated: bool,
        exit: std::result::Result<i32, String>,
    ) -> Self {
        let mut reply = Self::text(output, truncated);
        match exit {
            Ok(code) => reply.exit_code = Some(code),
            Err(error) => {
                reply.ok = false;
                reply.error = Some(error);
            }
        }
        reply
    }
    pub(crate) fn bounded(mut self, cap: usize) -> Self {
        let fields = [&mut self.output, self.error.get_or_insert_with(String::new)];
        while fields
            .iter()
            .map(|text| ascii_string_size(text))
            .sum::<usize>()
            + 104
            > cap
        {
            let index = usize::from(fields[0].is_empty());
            let field = &mut *fields[index];
            let len = field.chars().count();
            if len == 0 {
                break;
            }
            *field = if len > 64 {
                format!(
                    "{}\n[truncated to fit the result cap]",
                    prefix(field, len / 3)
                )
            } else {
                String::new()
            };
            self.truncated = true;
        }
        if self.error.as_ref().is_some_and(String::is_empty) {
            self.error = (!self.ok).then(|| "tool request failed".into());
        }
        self
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u8,
    name: String,
    #[serde(default = "empty_args")]
    args: Value,
    #[serde(default = "default_output")]
    max_output_chars: usize,
}

fn empty_args() -> Value {
    Value::Object(Default::default())
}

fn default_output() -> usize {
    20_000
}

pub(crate) fn dispatch(task: &Task, settings: &commands::Settings, raw: &[u8]) -> Result<Reply> {
    let request: Request =
        serde_json::from_slice(raw).map_err(|error| format!("bad request: {error}"))?;
    let limit = request.max_output_chars;
    if request.version != 1 {
        return Err("request must be an object with version 1".into());
    }
    if !(500..=default_output()).contains(&limit) {
        return Err("max_output_chars must be an integer from 500 to 20000".into());
    }
    if !request.args.is_object() {
        return Err("args must be an object".into());
    }
    if ascii_json_size(&request.args) > 24_000 {
        return Err("arguments are over the 24000-char limit".into());
    }
    let args = request.args;
    match request.name.as_str() {
        "read_file" => files::read(task.workspace(), decode(args)?, limit),
        "list_files" => files::list(task.workspace(), decode(args)?, limit),
        "search_files" => files::search(task.workspace(), decode(args)?, limit),
        "edit_file" => files::edit(task.workspace(), decode(args)?),
        "write_file" => files::write(task.workspace(), decode(args)?),
        "run_command" => commands::run(task, settings, decode(args)?, limit),
        "run_tests" => commands::test(task, settings, decode(args)?, limit),
        other => Err(format!("unknown tool {:?}", prefix(other, 64)).into()),
    }
    .map(|mut reply| {
        let (output, cut) = cap_text(reply.output, limit);
        reply.output = output;
        reply.truncated |= cut;
        reply
    })
}

fn decode<T: DeserializeOwned>(args: Value) -> Result<T> {
    serde_json::from_value(args).map_err(|error| format!("invalid arguments: {error}").into())
}

pub(crate) fn bounded_integer(
    value: Option<usize>,
    name: &str,
    default: usize,
    maximum: usize,
) -> Result<usize> {
    let chosen = value.unwrap_or(default);
    if !(1..=maximum).contains(&chosen) {
        return Err(format!("{name} must be between 1 and {maximum}").into());
    }
    Ok(chosen)
}

pub(crate) fn prefix(text: &str, len: usize) -> &str {
    text.char_indices()
        .nth(len)
        .map_or(text, |(index, _)| &text[..index])
}

pub(crate) fn cap_text(text: String, limit: usize) -> (String, bool) {
    let chars = text.chars().count();
    if chars <= limit {
        return (text, false);
    }
    let marker = format!("\n[truncated: showing {{}} of {chars} chars]");
    let keep = limit.saturating_sub(marker.len() + 8);
    (
        format!(
            "{}\n[truncated: showing {keep} of {chars} chars]",
            prefix(&text, keep)
        ),
        true,
    )
}

fn ascii_string_size(text: &str) -> usize {
    2 + text
        .chars()
        .map(|ch| match ch {
            '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
            ' '..='~' => 1,
            other => 6 * other.len_utf16(),
        })
        .sum::<usize>()
}

fn ascii_json_size(value: &Value) -> usize {
    match value {
        Value::String(text) => ascii_string_size(text),
        Value::Array(values) => {
            2 + values.len().saturating_sub(1) * 2
                + values.iter().map(ascii_json_size).sum::<usize>()
        }
        Value::Object(values) => {
            2 + values.len().saturating_sub(1) * 2
                + values
                    .iter()
                    .map(|(key, val)| ascii_string_size(key) + 2 + ascii_json_size(val))
                    .sum::<usize>()
        }
        scalar => scalar.to_string().len(),
    }
}
