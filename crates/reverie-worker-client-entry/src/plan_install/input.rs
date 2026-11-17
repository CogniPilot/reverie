use super::{Failure, Result, need};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub(super) const WIRE_LIMIT: usize = 1024 * 1024;
const AUTH_LIMIT: usize = 128 * 1024;
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Provider {
    Anthropic,
    Openai,
}
impl Provider {
    pub(super) fn directory(self) -> &'static str {
        match self {
            Self::Anthropic => "claude",
            Self::Openai => "codex",
        }
    }
    pub(super) fn credential(self) -> &'static str {
        match self {
            Self::Anthropic => ".credentials.json",
            Self::Openai => "auth.json",
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Role {
    ClaudeProjects,
    ClaudeInstructions,
    CodexSessions,
    CodexHistory,
    CodexInstructions,
}
impl Role {
    pub(super) fn filename(self) -> &'static str {
        match self {
            Self::ClaudeProjects => "projects",
            Self::ClaudeInstructions => "CLAUDE.md",
            Self::CodexSessions => "sessions",
            Self::CodexHistory => "history.jsonl",
            Self::CodexInstructions => "AGENTS.md",
        }
    }
    pub(super) fn provider(self) -> Provider {
        match self {
            Self::ClaudeProjects | Self::ClaudeInstructions => Provider::Anthropic,
            Self::CodexSessions | Self::CodexHistory | Self::CodexInstructions => Provider::Openai,
        }
    }
    pub(super) fn is_directory(self) -> bool {
        matches!(self, Self::ClaudeProjects | Self::CodexSessions)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(super) enum Source {
    None,
    Home {
        relative: Vec<String>,
        dev: String,
        ino: String,
    },
    Intake {
        dev: String,
        ino: String,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Conversation {
    pub(super) native_id: String,
    pub(super) relative: Vec<String>,
    pub(super) sha256: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Context {
    pub(super) source: Source,
    pub(super) roles: Vec<Role>,
    pub(super) conversation: Option<Conversation>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Payload {
    pub(super) version: u8,
    pub(super) purpose: String,
    pub(super) operation_id: String,
    pub(super) session_id: String,
    pub(super) container_id: String,
    pub(super) provider: Provider,
    pub(super) account_id: String,
    pub(super) auth: String,
    pub(super) identity: String,
    pub(super) context: Context,
}
pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(super) fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}
pub(super) fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_digit() || matches!(b, b'a'..=b'f')
            }
        })
}
pub(super) fn component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !matches!(value, "." | "..")
        && !value
            .bytes()
            .any(|b| b < 32 || matches!(b, 127 | b'/' | b'\\'))
}
fn relative(values: &[String]) -> bool {
    !values.is_empty()
        && values.len() <= 32
        && values.iter().all(|v| component(v))
        && values.iter().map(|v| v.len() + 1).sum::<usize>() <= 4096
}
pub(super) fn decimal(value: &str, positive: bool) -> Result<u64> {
    let number = value
        .parse::<u64>()
        .map_err(|error| Failure::new("identity-decimal", error))?;
    need(
        number.to_string() == value && (!positive || number > 0),
        "identity-decimal",
    )?;
    Ok(number)
}
fn valid_account(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 400
        && value.chars().count() <= 100
        && !value.bytes().any(|byte| byte < 32 || byte == 127)
}
fn identity(value: &str) -> bool {
    let Some((body, signature)) = value.split_once('.') else {
        return false;
    };
    value.len() <= 2048
        && !body.is_empty()
        && valid_digest(signature)
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
impl Context {
    pub(super) fn digest(&self) -> Result<String> {
        let value = serde_json::to_value(self).map_err(|e| Failure::new("context-json", e))?;
        Ok(digest(canonical(&value)?.as_bytes()))
    }
    fn validate(&self, provider: Provider) -> Result<()> {
        need(
            self.roles.len() <= 5
                && self.roles.iter().copied().collect::<BTreeSet<_>>().len() == self.roles.len(),
            "context-roles",
        )?;
        need(
            self.roles.iter().all(|role| role.provider() == provider),
            "context-provider",
        )?;
        match &self.source {
            Source::None => need(
                self.roles.is_empty() && self.conversation.is_none(),
                "context-none",
            )?,
            Source::Home {
                relative: path,
                dev,
                ino,
            } => {
                need(relative(path), "context-home-relative")?;
                decimal(dev, false)?;
                decimal(ino, true)?;
            }
            Source::Intake { dev, ino } => {
                decimal(dev, false)?;
                decimal(ino, true)?;
                let history = match provider {
                    Provider::Anthropic => Role::ClaudeProjects,
                    Provider::Openai => Role::CodexSessions,
                };
                need(
                    self.roles == [history] && self.conversation.is_some(),
                    "intake-selected-conversation-only",
                )?;
            }
        }
        if let Some(conversation) = &self.conversation {
            need(
                valid_uuid(&conversation.native_id)
                    && valid_digest(&conversation.sha256)
                    && relative(&conversation.relative),
                "context-conversation",
            )?;
            let role = match provider {
                Provider::Anthropic => Role::ClaudeProjects,
                Provider::Openai => Role::CodexSessions,
            };
            need(
                self.roles.contains(&role)
                    && conversation.relative.first().map(String::as_str) == Some(role.filename()),
                "context-history-role",
            )?;
            let name = conversation
                .relative
                .last()
                .ok_or_else(|| Failure::refused("context-conversation"))?;
            let correct = match provider {
                Provider::Anthropic => name == &format!("{}.jsonl", conversation.native_id),
                Provider::Openai => name.ends_with(&format!("-{}.jsonl", conversation.native_id)),
            };
            need(correct, "context-conversation-file")?;
        }
        Ok(())
    }
}
impl Payload {
    pub(super) fn parse(bytes: &[u8], expected: &str) -> Result<Self> {
        need(
            bytes.len() <= WIRE_LIMIT && valid_digest(expected),
            "payload-bound",
        )?;
        let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
        let value: Self =
            serde_json::from_slice(bytes).map_err(|error| Failure::new("payload-json", error))?;
        value.validate()?;
        let canonical =
            serde_json::to_vec(&value).map_err(|error| Failure::new("payload-canonical", error))?;
        need(
            canonical == bytes && digest(&canonical) == expected,
            "payload-digest",
        )?;
        Ok(value)
    }
    pub(super) fn identity_filename(&self) -> String {
        format!("worker-identity-{}", self.container_id)
    }
    fn validate(&self) -> Result<()> {
        need(
            self.version == 1 && self.purpose == "reverie-plan-install-v1",
            "payload-purpose",
        )?;
        need(
            valid_uuid(&self.operation_id)
                && valid_uuid(&self.session_id)
                && valid_digest(&self.container_id),
            "payload-identity",
        )?;
        need(valid_account(&self.account_id), "payload-account")?;
        need(identity(&self.identity), "payload-token")?;
        need(
            !self.auth.is_empty() && self.auth.len() <= AUTH_LIMIT,
            "payload-auth-bound",
        )?;
        let auth: serde_json::Value = serde_json::from_str(&self.auth)
            .map_err(|error| Failure::new("payload-auth-json", error))?;
        need(auth.is_object(), "payload-auth-object")?;
        self.context.validate(self.provider)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Material {
    pub(super) version: u8,
    pub(super) purpose: String,
    pub(super) operation_id: String,
    pub(super) session_id: String,
    pub(super) provider: Provider,
    pub(super) account_id: String,
    pub(super) auth_digest: String,
    pub(super) context: Context,
}
impl Material {
    pub(super) fn from_payload(value: &Payload) -> Self {
        Self {
            version: 1,
            purpose: "reverie-plan-material-v1".into(),
            operation_id: value.operation_id.clone(),
            session_id: value.session_id.clone(),
            provider: value.provider,
            account_id: value.account_id.clone(),
            auth_digest: digest(value.auth.as_bytes()),
            context: value.context.clone(),
        }
    }
    pub(super) fn validate(&self) -> Result<()> {
        need(
            self.version == 1
                && self.purpose == "reverie-plan-material-v1"
                && valid_uuid(&self.operation_id)
                && valid_uuid(&self.session_id)
                && valid_digest(&self.auth_digest),
            "material-scope",
        )?;
        need(valid_account(&self.account_id), "material-account")?;
        self.context.validate(self.provider)
    }
    pub(super) fn digest(&self) -> Result<String> {
        let value = serde_json::to_value(self).map_err(|e| Failure::new("material-json", e))?;
        let raw = canonical(&value)?;
        Ok(digest(raw.as_bytes()))
    }
}
fn canonical(value: &serde_json::Value) -> Result<String> {
    match value {
        serde_json::Value::Object(values) => {
            let mut items = values.iter().collect::<Vec<_>>();
            items.sort_by(|a, b| a.0.cmp(b.0));
            let mut fields = vec![];
            for (key, value) in items {
                fields.push(format!(
                    "{}:{}",
                    serde_json::to_string(key).map_err(|e| Failure::new("canonical-key", e))?,
                    canonical(value)?
                ));
            }
            Ok(format!("{{{}}}", fields.join(",")))
        }
        serde_json::Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(canonical)
                .collect::<Result<Vec<_>>>()?
                .join(",")
        )),
        _ => serde_json::to_string(value).map_err(|e| Failure::new("canonical-value", e)),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Payload {
        Payload {
            version: 1,
            purpose: "reverie-plan-install-v1".into(),
            operation_id: "11111111-1111-4111-8111-111111111111".into(),
            session_id: "22222222-2222-4222-8222-222222222222".into(),
            container_id: "c".repeat(64),
            provider: Provider::Anthropic,
            account_id: "synthetic-account-b".into(),
            auth: r#"{"syntheticAccount":"B","paid":false}"#.into(),
            identity: format!("synthetic.{}", "a".repeat(64)),
            context: Context {
                source: Source::None,
                roles: vec![],
                conversation: None,
            },
        }
    }
    #[test]
    fn exact_canonical_payload_and_hash_bind_secret_bytes() {
        let input = input();
        let bytes = serde_json::to_vec(&input).unwrap();
        let expected = digest(&bytes);
        assert!(Payload::parse(&bytes, &expected).is_ok());
        assert!(Payload::parse(&[bytes.clone(), b"\n".to_vec()].concat(), &expected).is_ok());
        assert!(Payload::parse(&serde_json::to_vec_pretty(&input).unwrap(), &expected).is_err());
        let mut changed = input;
        changed.auth = r#"{"syntheticAccount":"A","paid":false}"#.into();
        assert!(Payload::parse(&serde_json::to_vec(&changed).unwrap(), &expected).is_err());
        assert!(Payload::parse(&bytes, &"0".repeat(64)).is_err());
        assert!(Payload::parse(&[bytes, b"\n\n".to_vec()].concat(), &expected).is_err());
    }
    #[test]
    fn closed_roles_refuse_paths_provider_confusion_and_unknown_fields() {
        for role in [
            Role::CodexSessions,
            Role::CodexHistory,
            Role::CodexInstructions,
        ] {
            let mut value = input();
            value.context = Context {
                source: Source::Home {
                    relative: vec![".claude".into()],
                    dev: "1".into(),
                    ino: "2".into(),
                },
                roles: vec![role],
                conversation: None,
            };
            assert!(value.validate().is_err());
        }
        for name in [
            "",
            ".",
            "..",
            "/elsewhere",
            "a/b",
            "a\\b",
            "bad\nname",
            "bad\0name",
        ] {
            assert!(!component(name));
        }
        let mut raw = serde_json::to_value(input()).unwrap();
        raw["command"] = serde_json::json!("never execute");
        assert!(serde_json::from_value::<Payload>(raw).is_err());
    }
    #[test]
    fn same_provider_history_requires_exact_native_file_and_digest() {
        let mut value = input();
        let native_id = "33333333-3333-4333-8333-333333333333";
        value.context = Context {
            source: Source::Home {
                relative: vec![".claude".into()],
                dev: "1".into(),
                ino: "2".into(),
            },
            roles: vec![Role::ClaudeProjects],
            conversation: Some(Conversation {
                native_id: native_id.into(),
                relative: vec![
                    "projects".into(),
                    "synthetic-workspace".into(),
                    format!("{native_id}.jsonl"),
                ],
                sha256: "b".repeat(64),
            }),
        };
        assert!(value.validate().is_ok());
        value.context.conversation.as_mut().unwrap().relative[2] = "different.jsonl".into();
        assert!(value.validate().is_err());
        value.context.conversation.as_mut().unwrap().relative[2] = format!("{native_id}.jsonl");
        value.context.roles.push(Role::ClaudeProjects);
        assert!(value.validate().is_err());
    }
    #[test]
    fn no_ambient_identity_or_unbounded_material() {
        for token in [
            String::new(),
            format!("synthetic.{}\n", "a".repeat(64)),
            "synthetic.extra.part".into(),
        ] {
            let mut value = input();
            value.identity = token;
            assert!(value.validate().is_err());
        }
        let mut value = input();
        value.auth = "x".repeat(AUTH_LIMIT + 1);
        assert!(value.validate().is_err());
        value.auth = "[]".into();
        assert!(value.validate().is_err());
        value.auth = "{}".into();
        value.account_id = "unsafe\nname".into();
        assert!(value.validate().is_err());
        assert!(decimal("01", false).is_err());
        assert!(decimal("0", true).is_err());
    }
}

#[cfg(test)]
mod role_contract_tests {
    use super::*;
    #[test]
    fn fixed_target_paths_are_provider_owned_and_never_settings_or_commands() {
        assert_eq!(Provider::Anthropic.directory(), "claude");
        assert_eq!(Provider::Anthropic.credential(), ".credentials.json");
        assert_eq!(Provider::Openai.directory(), "codex");
        assert_eq!(Provider::Openai.credential(), "auth.json");
        assert_eq!(Role::ClaudeProjects.filename(), "projects");
        assert!(Role::ClaudeProjects.is_directory());
        assert_eq!(Role::CodexSessions.filename(), "sessions");
        assert!(Role::CodexSessions.is_directory());
        for role in [
            Role::ClaudeInstructions,
            Role::CodexHistory,
            Role::CodexInstructions,
        ] {
            assert!(!role.is_directory());
            assert!(!role.filename().contains("settings"));
        }
    }
}

#[cfg(test)]
mod account_data_tests {
    use super::*;
    #[test]
    fn selected_account_ids_are_data_never_path_components() {
        assert!(valid_account("profile.example/account@example.test 😀"));
        assert!(!valid_account("bad\naccount"));
        assert!(!valid_account(&"x".repeat(101)));
    }
}
