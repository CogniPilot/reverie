//! Named path-free memory bridge requests. Instance/model/credential selection
//! is installation data, never a JSON request field or caller-owned grant.
mod journal;
mod reply;
mod screening;
use crate::{
    legacy_json::{self, Node, Text, Value, ordered::OrderedValue, truthy},
    storage_identity::MetadataText,
};
pub use journal::JournalSaveRequest;
pub use reply::{JournalEntries, JournalReplyError, JournalSaveData, MemoryReply};
use reverie_core::{
    PythonTextRef,
    memory::{MemoryScope, ProjectName},
};
pub use screening::{OutputPolicy, OutputPolicyError};
type Result<T> = std::result::Result<T, MemoryRequestError>;
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum MemoryRequestError {
    Json,
    ExpectedAction,
    UnknownField,
    Scope,
    PrivateWork,
    Project,
    ScreenText,
    RememberText,
}
impl std::fmt::Display for MemoryRequestError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str(match self {
            Self::Json => "invalid memory JSON request",
            Self::ExpectedAction => "expected a screen, recall or remember JSON object",
            Self::UnknownField => "unsupported memory request field",
            Self::Scope => "select exactly one project or private scope",
            Self::PrivateWork => "private memory is unavailable in shared channels",
            Self::Project => "project must be a lowercase project identifier",
            Self::ScreenText => "screen needs text",
            Self::RememberText => "memory is empty or crossed a hard floor",
        })
    }
}
impl std::error::Error for MemoryRequestError {}
pub enum MemoryRequest {
    Screen {
        text: MetadataText,
    },
    Recall {
        scope: MemoryScope,
        query: MetadataText,
    },
    Remember {
        request: JournalSaveRequest,
    },
}
impl MemoryRequest {
    pub fn decode(text: PythonTextRef<'_>) -> Result<Self> {
        let data =
            legacy_json::decode_memory_cli_text(text).map_err(|_| MemoryRequestError::Json)?;
        let Node::Object(fields) = &data.value.0 else {
            return Err(MemoryRequestError::ExpectedAction);
        };
        const ALLOWED: [&str; 13] = [
            "action",
            "query",
            "text",
            "private",
            "project",
            "channel",
            "room",
            "turn",
            "tag",
            "quote",
            "source",
            "reason",
            "visibility",
        ];
        if fields.keys().any(|key| {
            !ALLOWED
                .iter()
                .any(|name| key.0.iter().copied().eq(name.chars().map(u32::from)))
        }) {
            return Err(MemoryRequestError::UnknownField);
        }
        let get = |name: &str| fields.get(&key(name));
        let action = get("action")
            .and_then(as_text)
            .ok_or(MemoryRequestError::ExpectedAction)?;
        if action.as_python_text_ref() == "screen" {
            let text = get("text")
                .and_then(as_text)
                .filter(|text| !text.as_python_text_ref().trimmed().is_empty())
                .ok_or(MemoryRequestError::ScreenText)?;
            return Ok(Self::Screen { text });
        }
        if action.as_python_text_ref() != "recall" && action.as_python_text_ref() != "remember" {
            return Err(MemoryRequestError::ExpectedAction);
        }
        let project = truthy(get("project"));
        let private = truthy(get("private"));
        if project == private {
            return Err(MemoryRequestError::Scope);
        }
        if private
            && get("channel")
                .and_then(as_text)
                .is_some_and(|text| text.as_python_text_ref() == "work")
        {
            return Err(MemoryRequestError::PrivateWork);
        }
        if action.as_python_text_ref() == "recall" {
            let scope = if project {
                MemoryScope::Project(
                    get("project")
                        .and_then(as_text)
                        .and_then(|text| text.scalar_text())
                        .and_then(|name| ProjectName::parse(&name))
                        .ok_or(MemoryRequestError::Project)?,
                )
            } else {
                MemoryScope::Private
            };
            return Ok(Self::Recall {
                scope,
                query: field_string(&data, "query", ""),
            });
        }
        Ok(Self::Remember {
            request: JournalSaveRequest::from_data(&data)?,
        })
    }
}
fn key(text: &str) -> Text {
    Text(text.chars().map(u32::from).collect())
}
fn as_text(value: &Value) -> Option<MetadataText> {
    if let Node::String(value) = &value.0 {
        Some(MetadataText::from_text(value.clone()))
    } else {
        None
    }
}
fn field_string(data: &OrderedValue, name: &str, default: &str) -> MetadataText {
    let Node::Object(fields) = &data.value.0 else {
        unreachable!("named request decoder object")
    };
    let Some(value) = fields.get(&key(name)) else {
        return MetadataText::from_scalar_text(default);
    };
    let index = data
        .root_child_index(&key(name))
        .expect("parsed source order graph");
    MetadataText::from_text(
        OrderedValue {
            value: value.deep_clone(),
            graph: data.graph.with_root(index),
        }
        .python_string(),
    )
}
