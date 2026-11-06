//! Named memory/agent settings captured once at service bootstrap. These are
//! configuration data, never an employee grant or filesystem custody proof.
use crate::{PythonText, python_text::numeric_ascii};
use std::collections::BTreeMap;

/// Python int(str), including decimal Unicode digits, underscore grammar and
/// the frozen 4300-digit limit. Keep accepted values beyond SQLite/i64 intact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigInteger(String);
impl ConfigInteger {
    pub fn parse(value: &PythonText) -> Option<Self> {
        let raw = numeric_ascii(value.codepoints())?;
        let raw = raw.trim_matches(|cp| matches!(cp, ' ' | '\t' | '\n' | '\r' | '\u{b}' | '\u{c}'));
        let (negative, body) = if let Some(body) = raw.strip_prefix('-') {
            (true, body)
        } else {
            (false, raw.strip_prefix('+').unwrap_or(raw))
        };
        if body.is_empty() || body.bytes().filter(u8::is_ascii_digit).count() > 4300 {
            return None;
        }
        for (index, byte) in body.bytes().enumerate() {
            if !(byte.is_ascii_digit()
                || byte == b'_'
                    && index > 0
                    && index + 1 < body.len()
                    && body.as_bytes()[index - 1].is_ascii_digit()
                    && body.as_bytes()[index + 1].is_ascii_digit())
            {
                return None;
            }
        }
        let digits = body.replace('_', "");
        let digits = digits.trim_start_matches('0');
        if digits.is_empty() {
            Some(Self("0".into()))
        } else {
            Some(Self(format!("{}{digits}", if negative { "-" } else { "" })))
        }
    }
    pub fn from_i64(value: i64) -> Self {
        Self(value.to_string())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn to_i64(&self) -> Option<i64> {
        self.0.parse().ok()
    }
    pub fn to_usize(&self) -> Option<usize> {
        self.0.parse().ok()
    }
}
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum IntegerSetting {
    RequestTimeout,
    EmbedDimensions,
    GpuLockWait,
    ShortTermTurns,
    RecallCount,
    ProfileMaxCharacters,
    PollInterval,
    JokeInterval,
    ReflectInterval,
    ReflectMinEpisodes,
    RatingBatch,
    SleepMinIdle,
    DreamsPerSleep,
    DreamSpacing,
    ReplyMaxTokens,
    ReplyMaxWords,
    ReplyMaxCharacters,
    VoiceReplyMaxTokens,
    VoiceReplyMaxWords,
}
impl IntegerSetting {
    pub fn definitions() -> &'static [(Self, Option<&'static str>, i64)] {
        use IntegerSetting::*;
        &[
            (RequestTimeout, Some("TIMEOUT"), 240),
            (EmbedDimensions, Some("EMBED_DIMS"), 1024),
            (GpuLockWait, Some("GPU_LOCK_WAIT"), 90),
            (ShortTermTurns, Some("SHORT_TERM_TURNS"), 20),
            (RecallCount, Some("RECALL_K"), 6),
            (ProfileMaxCharacters, None, 2000),
            (PollInterval, Some("POLL"), 10),
            (JokeInterval, Some("INTERVAL"), 240),
            (ReflectInterval, Some("REFLECT_INTERVAL"), 1800),
            (ReflectMinEpisodes, Some("REFLECT_MIN_EPISODES"), 3),
            (RatingBatch, None, 3),
            (SleepMinIdle, Some("SLEEP_MIN_IDLE"), 1800),
            (DreamsPerSleep, Some("DREAMS_PER_SLEEP"), 0),
            (DreamSpacing, Some("DREAM_SPACING"), 3600),
            (ReplyMaxTokens, Some("REPLY_MAX_TOKENS"), 400),
            (ReplyMaxWords, Some("REPLY_MAX_WORDS"), 150),
            (ReplyMaxCharacters, Some("REPLY_MAX_CHARS"), 1200),
            (VoiceReplyMaxTokens, Some("VOICE_REPLY_MAX_TOKENS"), 600),
            (VoiceReplyMaxWords, Some("VOICE_REPLY_MAX_WORDS"), 0),
        ]
    }
}
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum FloatSetting {
    RecencyDecay,
    DefaultImportance,
    JokeImportance,
    DreamMoodWeight,
    DreamRecallHours,
    ReplyTemperature,
}
impl FloatSetting {
    pub fn definitions() -> &'static [(Self, Option<&'static str>, f64)] {
        use FloatSetting::*;
        &[
            (RecencyDecay, Some("RECENCY_DECAY"), 0.995),
            (DefaultImportance, None, 3.0),
            (JokeImportance, None, 2.0),
            (DreamMoodWeight, Some("DREAM_MOOD_WEIGHT"), 1.0),
            (DreamRecallHours, Some("DREAM_RECALL_HOURS"), 24.0),
            (ReplyTemperature, None, 0.9),
        ]
    }
}
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum TextSetting {
    ApiBase,
    Model,
    EmbedUrl,
    EmbedModel,
    EmbedDocumentPrefix,
    EmbedQueryPrefix,
    SessionId,
    OwnerAliases,
    AgentAliases,
}
impl TextSetting {
    pub fn definitions() -> &'static [(Self, &'static str, &'static str)] {
        use TextSetting::*;
        &[
            (ApiBase, "API_BASE", "http://127.0.0.1:8080/v1"),
            (Model, "MODEL", "MODEL_ID"),
            (EmbedUrl, "EMBED_URL", ""),
            (EmbedModel, "EMBED_MODEL", ""),
            (EmbedDocumentPrefix, "EMBED_DOC_PREFIX", "search_document: "),
            (EmbedQueryPrefix, "EMBED_QUERY_PREFIX", "search_query: "),
            (SessionId, "SESSION_ID", ""),
            (OwnerAliases, "OWNER_ALIASES", ""),
            (AgentAliases, "AGENT_ALIASES", ""),
        ]
    }
}
/// Environment lookup selects only exact REVERIE names and keeps non-scalar
/// values. Empty strings use the original env_names.lookup default.
pub struct AgentSettings {
    integers: BTreeMap<IntegerSetting, ConfigInteger>,
    floats: BTreeMap<FloatSetting, f64>,
    text: BTreeMap<TextSetting, PythonText>,
}
impl AgentSettings {
    pub fn capture(environment: &BTreeMap<String, PythonText>) -> Self {
        let integers = IntegerSetting::definitions()
            .iter()
            .map(|&(key, name, default)| {
                let value = name
                    .and_then(|name| lookup(environment, name))
                    .and_then(ConfigInteger::parse)
                    .unwrap_or_else(|| ConfigInteger::from_i64(default));
                (key, value)
            })
            .collect();
        let floats = FloatSetting::definitions()
            .iter()
            .map(|&(key, name, default)| {
                let value = name
                    .and_then(|name| lookup(environment, name))
                    .and_then(|value| {
                        crate::memory::parse_embedding_float_text(value.codepoints()).ok()
                    })
                    .unwrap_or(default);
                (key, value)
            })
            .collect();
        let text = TextSetting::definitions()
            .iter()
            .map(|&(key, name, default)| {
                (
                    key,
                    lookup(environment, name)
                        .cloned()
                        .unwrap_or_else(|| PythonText::from_scalar_text(default)),
                )
            })
            .collect();
        Self {
            integers,
            floats,
            text,
        }
    }
    pub fn integer(&self, key: IntegerSetting) -> &ConfigInteger {
        &self.integers[&key]
    }
    pub fn float(&self, key: FloatSetting) -> f64 {
        self.floats[&key]
    }
    pub fn text(&self, key: TextSetting) -> &PythonText {
        &self.text[&key]
    }
}
pub fn lookup<'a>(
    environment: &'a BTreeMap<String, PythonText>,
    suffix: &str,
) -> Option<&'a PythonText> {
    environment
        .get(&format!("REVERIE_{suffix}"))
        .filter(|value| !value.codepoints().is_empty())
}
