//! `GET /api/subscription-profiles` v1: the request the TS front forwards and the exact response bytes
//! its route returns. The file grammar is ECMAScript `JSON.parse`, the schema is zod 4.4.3
//! `subscriptionProfileSchema`, and the body is `JSON.stringify` output. This JS codec shares no code
//! with the Python-compatible profile codec.
mod parse;
mod stringify;

pub use parse::{InvalidFile, parse_file};
pub use stringify::{invalid_file, profiles_response};

use serde::Deserialize;
use std::fmt;

/// TS reads the whole file; larger files are refused (curated 503) instead of buffered.
pub const MAX_FILE_BYTES: usize = 1 << 20;
pub const MAX_REQUEST_BYTES: usize = 64 << 10;
pub const MAX_RESPONSE_BYTES: usize = 8 << 20;
pub const MAX_PROFILES: usize = 32;
pub const CONTENT_TYPE: &str = "application/json; charset=utf-8";

/// A JS string value: UTF-16 code units, which `JSON.parse` lets carry lone surrogates.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JsString(Vec<u16>);
impl JsString {
    pub fn units(&self) -> &[u16] {
        &self.0
    }
}
impl From<&str> for JsString {
    fn from(value: &str) -> Self {
        Self(value.encode_utf16().collect())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Provider {
    Anthropic,
    Openai,
}
impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::Openai => "openai",
        }
    }
    pub fn credential_file(self) -> &'static str {
        match self {
            Self::Anthropic => ".credentials.json",
            Self::Openai => "auth.json",
        }
    }
    fn parse(units: &[u16]) -> Option<Self> {
        [Self::Anthropic, Self::Openai]
            .into_iter()
            .find(|provider| units.iter().copied().eq(provider.as_str().encode_utf16()))
    }
}

/// Node `path` flavour of the TS server, from `process.platform`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Platform {
    Posix,
    Win32,
}
impl Platform {
    pub fn from_node(platform: &str) -> Self {
        if platform == "win32" {
            Self::Win32
        } else {
            Self::Posix
        }
    }
    /// Node `path.isAbsolute`.
    pub fn is_absolute(self, path: &[u16]) -> bool {
        let separator = |unit: Option<&u16>| match self {
            Self::Posix => unit == Some(&u16::from(b'/')),
            Self::Win32 => {
                matches!(unit, Some(&unit) if unit == u16::from(b'/') || unit == u16::from(b'\\'))
            }
        };
        let drive = |unit: u16| u8::try_from(unit).is_ok_and(|byte| byte.is_ascii_alphabetic());
        separator(path.first())
            || (self == Self::Win32
                && path.len() > 2
                && drive(path[0])
                && path[1] == u16::from(b':')
                && separator(path.get(2)))
    }
}

/// One profile in schema order. Fields are unchecked; `checked` is the zod parse.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Profile {
    pub id: JsString,
    pub label: JsString,
    pub provider: Provider,
    pub config_dir: JsString,
    pub open_code_data_dir: JsString,
}
impl Profile {
    /// `subscriptionProfileSchema.parse`: id pattern, trimmed label of 1 to 64 UTF-16 units, absolute paths.
    pub fn checked(self, platform: Platform) -> Option<Self> {
        let id = self.id.units();
        let id_unit = |unit: &u16, first: bool| {
            u8::try_from(*unit).is_ok_and(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || (!first && (byte == b'_' || byte == b'-'))
            })
        };
        let id_ok = (1..=64).contains(&id.len())
            && id_unit(&id[0], true)
            && id[1..].iter().all(|unit| id_unit(unit, false));
        let label = JsString(trim(self.label.units()).to_vec());
        let label_ok = (1..=64).contains(&label.units().len());
        let paths_ok = platform.is_absolute(self.config_dir.units())
            && platform.is_absolute(self.open_code_data_dir.units());
        (id_ok && label_ok && paths_ok).then_some(Self { label, ..self })
    }
}

/// ECMAScript `String.prototype.trim`: WhiteSpace and LineTerminator at both ends.
fn trim(units: &[u16]) -> &[u16] {
    let space = |unit: &u16| {
        matches!(
            *unit,
            0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
        )
    };
    let start = units
        .iter()
        .position(|unit| !space(unit))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|unit| !space(unit))
        .map_or(start, |last| last + 1);
    &units[start..end]
}

/// What TS forwards after its own auth: its memoized CLI-registry modes and its own environment.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub modes_by_provider: Modes,
    pub env: Environment,
    /// `os.homedir()`, `process.cwd()`, `process.platform` and `getDataDir()` of the TS process.
    pub home: String,
    pub cwd: String,
    pub platform: String,
    pub data_dir: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Modes {
    pub anthropic: Vec<String>,
    pub openai: Vec<String>,
}
impl Modes {
    pub fn of(&self, provider: Provider) -> &[String] {
        match provider {
            Provider::Anthropic => &self.anthropic,
            Provider::Openai => &self.openai,
        }
    }
}
/// The `process.env` values the route reads; absent means unset.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Environment {
    #[serde(rename = "CLAUDE_CONFIG_DIR")]
    pub claude_config_dir: Option<String>,
    #[serde(rename = "CODEX_HOME")]
    pub codex_home: Option<String>,
    #[serde(rename = "XDG_DATA_HOME")]
    pub xdg_data_home: Option<String>,
}

pub fn decode_request(raw: &[u8]) -> Result<Request, Refusal> {
    if raw.len() > MAX_REQUEST_BYTES {
        return Err(Refusal::RequestBound);
    }
    serde_json::from_slice(raw).map_err(|_| Refusal::RequestSchema)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Outcomes TS has no equivalent for. The forwarder answers each with its curated 503, never a fallback.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Refusal {
    RequestBound,
    RequestSchema,
    Platform,
    FileBound,
    ResponseBound,
}
impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::RequestBound => "REQUEST_BOUND",
            Self::RequestSchema => "REQUEST_SCHEMA",
            Self::Platform => "PLATFORM",
            Self::FileBound => "FILE_BOUND",
            Self::ResponseBound => "RESPONSE_BOUND",
        }
    }
}
impl fmt::Display for Refusal {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for Refusal {}
