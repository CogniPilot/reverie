//! Interpret message addressing consistently in Hands wake and workspace routing.
use crate::hands_settings::truthy;
use reverie_core::PythonTextRef;
use reverie_python_regex::CompiledPattern;
use serde::Deserialize;
use serde_json::Value;
use std::cell::OnceCell;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Scope {
    pub(super) session: Option<String>,
    pub(super) name: Option<String>,
    pub(super) direct: bool,
}

pub(super) struct WakePolicy<'a> {
    scope: &'a Scope,
    history: &'a [Value],
    mentions: OnceCell<Option<CompiledPattern>>,
}

impl<'a> WakePolicy<'a> {
    pub(super) fn new(scope: &'a Scope, history: &'a [Value]) -> Self {
        Self {
            scope,
            history,
            mentions: OnceCell::new(),
        }
    }

    pub(super) fn accepts(&self, message: &Value) -> bool {
        let sender = &message["from"];
        let session = self.scope.session.as_deref();
        if session.is_some() && sender["sessionId"].as_str() == session {
            return false;
        }
        if let Some(wake) = message["phoneWake"].as_bool() {
            return wake;
        }
        if sender["kind"].as_str() == Some("user")
            || self.scope.direct
            || session.is_some_and(|session| {
                addressed_to(message, session)
                    || replied_to(self.history, &message["replyTo"], session)
            })
        {
            return true;
        }
        let text = message["text"].as_str().unwrap_or_default();
        self.mentions
            .get_or_init(|| mention_pattern([self.scope.name.as_deref().unwrap_or(""), "everyone"]))
            .as_ref()
            .is_some_and(|pattern| pattern.is_match(PythonTextRef::from_scalar_text(text)))
    }
}

pub(super) fn addressed_to(message: &Value, session: &str) -> bool {
    message["to"]
        .as_array()
        .is_some_and(|to| to.iter().any(|target| target.as_str() == Some(session)))
}

pub(super) fn replied_to(history: &[Value], reply: &Value, session: &str) -> bool {
    history
        .iter()
        .find(|item| item["id"] == *reply && !truthy(&item["deleted"]))
        .is_some_and(|item| item["from"]["sessionId"].as_str() == Some(session))
}

pub(super) fn mentioned(name: &str, text: &str) -> bool {
    mention_pattern([name])
        .is_some_and(|pattern| pattern.is_match(PythonTextRef::from_scalar_text(text)))
}

fn mention_pattern<'a>(names: impl IntoIterator<Item = &'a str>) -> Option<CompiledPattern> {
    let mut names = names.into_iter().filter(|name| !name.is_empty()).peekable();
    names.peek()?;
    let mut pattern = String::from(r"(?<![\w@])@(?:");
    for (index, name) in names.enumerate() {
        if index != 0 {
            pattern.push('|');
        }
        for character in name.chars() {
            if r"\.^$|?*+()[]{}-".contains(character) {
                pattern.push('\\');
            }
            pattern.push(character);
        }
    }
    pattern.push_str(r")(?![\w-])");
    CompiledPattern::compile(PythonTextRef::from_scalar_text(&pattern)).ok()
}
