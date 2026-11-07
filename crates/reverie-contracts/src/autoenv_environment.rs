//! Nix exported-variable and legacy NUL-cache DATA, never executable authority.
//! Both producer and consumer validate assignments before publishing/applying any.
use crate::legacy_json::{self, Node, Text, Value};
use reverie_core::PythonTextRef;
use std::collections::BTreeMap;

const DENY: &[&str] = &[
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "TEMPDIR",
    "PWD",
    "OLDPWD",
    "SHELL",
    "TERM",
    "USER",
    "LOGNAME",
    "SHLVL",
    "BASH_ENV",
    "NIX_BUILD_TOP",
    "NIX_LOG_FD",
    "out",
    "outputs",
    "builder",
    "buildPhase",
    "shellHook",
    "IN_NIX_SHELL",
];
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum EnvironmentError {
    Json,
    Variables,
    Assignment,
    Encoding,
    Cache,
}
impl std::fmt::Display for EnvironmentError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(match self {
            Self::Json => "autoenv input must be UTF-8 JSON text",
            Self::Variables => "autoenv variables and their descriptions must be objects",
            Self::Assignment => "autoenv exported variable has an unsafe name",
            Self::Encoding => "autoenv exported assignment must encode as UTF-8",
            Self::Cache => "autoenv cache contains an invalid, duplicate or denied assignment",
        })
    }
}
impl std::error::Error for EnvironmentError {}
/// A complete validated collection. No partial cache/export iterator is exposed.
#[derive(Debug)]
pub struct AutoenvEnvironment(BTreeMap<String, String>);
impl AutoenvEnvironment {
    /// Preserve the Python producer's last-key-wins JSON, codepoint sorting,
    /// exported-only selection, denied variables and NUL-value omission.
    /// Malformed eligible names now refuse rather than emitting ambiguous NUL
    /// records that could bypass the deny list in the former Bash consumer.
    pub fn from_nix_text(raw: &[u8]) -> Result<Self, EnvironmentError> {
        let text = legacy_json::utf8_file_text(raw).map_err(|_| EnvironmentError::Json)?;
        let document =
            legacy_json::decode_python_str(text.as_bytes()).map_err(|_| EnvironmentError::Json)?;
        let variables =
            object(field(object(&document)?, "variables").ok_or(EnvironmentError::Variables)?)?;
        let mut assignments = BTreeMap::new();
        for (name, description) in variables {
            let description = object(description)?;
            if !matches!(field(description, "type"), Some(Value(Node::String(t))) if t.equals_ascii("exported"))
                || DENY.iter().any(|denied| name.equals_ascii(denied))
            {
                continue;
            }
            let Some(Value(Node::String(value))) = field(description, "value") else {
                continue;
            };
            if value.0.contains(&0) {
                continue;
            }
            let name = scalar(name)?;
            if !allowed_name(&name) {
                return Err(EnvironmentError::Assignment);
            }
            assignments.insert(name, scalar(value)?);
        }
        Ok(Self(assignments))
    }
    /// Also validate existing caches: treating their bytes as trusted would
    /// retain the old HOME-injection bug during an otherwise compatible upgrade.
    pub fn from_cache(raw: &[u8]) -> Result<Self, EnvironmentError> {
        let mut assignments = BTreeMap::new();
        if !raw.is_empty() && raw.last() != Some(&0) {
            return Err(EnvironmentError::Cache);
        }
        for record in raw
            .strip_suffix(&[0])
            .unwrap_or(raw)
            .split(|&byte| byte == 0)
            .filter(|record| !raw.is_empty() || !record.is_empty())
        {
            let record = std::str::from_utf8(record).map_err(|_| EnvironmentError::Cache)?;
            let (name, value) = record.split_once('=').ok_or(EnvironmentError::Cache)?;
            if !allowed_name(name)
                || assignments
                    .insert(name.to_owned(), value.to_owned())
                    .is_some()
            {
                return Err(EnvironmentError::Cache);
            }
        }
        Ok(Self(assignments))
    }
    pub fn assignments(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
    }
    pub fn cache_bytes(&self) -> Vec<u8> {
        let mut raw = Vec::new();
        for (name, value) in self.assignments() {
            raw.extend_from_slice(name.as_bytes());
            raw.push(b'=');
            raw.extend_from_slice(value.as_bytes());
            raw.push(0);
        }
        raw
    }
    /// Companion diagnostics retain the existing schema and lossless paths.
    /// Its JSON is informational; only the NUL cache is consumed by the launcher.
    pub fn manifest(
        &self,
        repository: PythonTextRef<'_>,
        attribute: PythonTextRef<'_>,
        commands: &[reverie_core::PythonText],
        key: &str,
    ) -> Vec<u8> {
        let value = Value(Node::Object(
            [
                ("repo", text(repository)),
                ("attr", text(attribute)),
                (
                    "commands",
                    Value(Node::Array(
                        commands.iter().map(|s| text(s.as_text_ref())).collect(),
                    )),
                ),
                ("key", text(PythonTextRef::from_scalar_text(key))),
                (
                    "vars",
                    Value(Node::Array(
                        self.0
                            .keys()
                            .map(|s| text(PythonTextRef::from_scalar_text(s)))
                            .collect(),
                    )),
                ),
            ]
            .into_iter()
            .map(|(key, value)| (Text(key.chars().map(u32::from).collect()), value))
            .collect(),
        ));
        crate::worker_config::encode_data(&value)
    }
}
fn object(value: &Value) -> Result<&BTreeMap<Text, Value>, EnvironmentError> {
    match &value.0 {
        Node::Object(value) => Ok(value),
        _ => Err(EnvironmentError::Variables),
    }
}
fn field<'a>(values: &'a BTreeMap<Text, Value>, name: &str) -> Option<&'a Value> {
    values.get(&Text(name.chars().map(u32::from).collect()))
}
fn scalar(text: &Text) -> Result<String, EnvironmentError> {
    text.0
        .iter()
        .map(|&cp| char::from_u32(cp).ok_or(EnvironmentError::Encoding))
        .collect()
}
fn text(text: PythonTextRef<'_>) -> Value {
    Value(Node::String(Text(text.codepoints().into_owned())))
}
fn allowed_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|b| b == b'_' || b.is_ascii_alphabetic())
        && bytes.all(|b| b == b'_' || b.is_ascii_alphanumeric())
        && !DENY.contains(&name)
}
