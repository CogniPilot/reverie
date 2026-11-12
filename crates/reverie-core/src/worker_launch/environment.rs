use super::{LaunchRuleError, valid_text};

/// The shared exact worker environment-key vocabulary. Frame/value bounds are
/// purpose-specific and are not imposed on the native client by this type.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvironmentKey(String);
impl EnvironmentKey {
    pub fn parse(value: &str) -> Result<Self, LaunchRuleError> {
        if !allowed(value) {
            return Err(LaunchRuleError::Environment);
        }
        Ok(Self(value.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
fn allowed(key: &str) -> bool {
    const EXACT: &[&str] = &[
        "LANG",
        "LC_ALL",
        "TERM",
        "COLORTERM",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "REVERIE_SESSION_ID",
        "REVERIE_MUX",
        "REVERIE_MUX_NAME",
        "REVERIE_PARENT_SESSION_ID",
        "REVERIE_API_URL",
        "REVERIE_HOOK_SECRET_FILE",
        "REVERIE_HOOK_GENERATION",
        "DISABLE_AUTOUPDATER",
        "DISABLE_UPDATES",
    ];
    const PREFIXES: &[&str] = &[
        "CLAUDE_",
        "CODEX_",
        "OPENCODE_",
        "OPENAI_",
        "ANTHROPIC_",
        "GEMINI_",
        "GOOGLE_",
        "REVERIE_STATUSLINE_",
        "REVERIE_HANDS_",
    ];
    EXACT.contains(&key)
        || PREFIXES.iter().any(|prefix| {
            key.strip_prefix(prefix).is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix.bytes().all(|byte| {
                        byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                    })
            })
        })
}

/// Unique keys in original request insertion order; no sorting/defaults.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerEnvironment(Vec<(EnvironmentKey, Vec<u32>)>);
impl WorkerEnvironment {
    pub fn try_new(entries: Vec<(EnvironmentKey, Vec<u32>)>) -> Result<Self, LaunchRuleError> {
        let mut keys = std::collections::BTreeSet::new();
        if entries.len() > 128
            || entries.iter().any(|(key, value)| {
                !keys.insert(key.as_str()) || value.len() > 65536 || !valid_text(value)
            })
        {
            return Err(LaunchRuleError::Environment);
        }
        Ok(Self(entries))
    }
    pub fn entries(&self) -> &[(EnvironmentKey, Vec<u32>)] {
        &self.0
    }
    pub fn get(&self, key: &str) -> Option<&[u32]> {
        self.0
            .iter()
            .find(|(name, _)| name.as_str() == key)
            .map(|(_, value)| value.as_slice())
    }
}
