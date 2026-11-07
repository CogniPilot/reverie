use super::*;
use crate::legacy_json::{self, truthy};
pub struct LegacyEpisode {
    pub user: MetadataText,
    pub assistant: MetadataText,
}
pub struct LegacyHistory {
    episodes: Vec<LegacyEpisode>,
}
impl LegacyHistory {
    pub fn decode(raw: &str) -> Result<Self> {
        let value = legacy_json::decode_python_str(raw.as_bytes())
            .map_err(|_| MemoryJsonError::InvalidJson)?;
        let Node::Array(turns) = &value.0 else {
            return Ok(Self {
                episodes: Vec::new(),
            });
        };
        let mut episodes = Vec::new();
        let mut pending = None;
        for turn in turns {
            let Node::Object(fields) = &turn.0 else {
                return Err(MemoryJsonError::ExpectedHistoryTurn);
            };
            let content = match fields.get(&text("content")).filter(|v| truthy(Some(v))) {
                None => Text(Vec::new()),
                Some(Value(Node::String(text))) => trim(text),
                _ => return Err(MemoryJsonError::ExpectedHistoryText),
            };
            match fields.get(&text("role")) {
                Some(Value(Node::String(role))) if role.equals_ascii("user") => {
                    pending = Some(content)
                }
                Some(Value(Node::String(role))) if role.equals_ascii("assistant") => {
                    record_assistant(&mut pending, content, &mut episodes);
                }
                _ => {}
            }
        }
        Ok(Self { episodes })
    }
    pub fn episodes(&self) -> &[LegacyEpisode] {
        &self.episodes
    }
}
fn record_assistant(pending: &mut Option<Text>, content: Text, episodes: &mut Vec<LegacyEpisode>) {
    if let Some(user) = pending.take() {
        episodes.push(LegacyEpisode {
            user: MetadataText::from_text(user),
            assistant: MetadataText::from_text(content),
        });
    }
}
fn trim(value: &Text) -> Text {
    // Metadata codepoints include lone surrogates. Python strip leaves them
    // intact; apply the shared scalar whitespace rule only where representable.
    let whitespace = |&point: &u32| {
        char::from_u32(point)
            .is_some_and(|cp| reverie_core::memory::trim_text(&cp.to_string()).is_empty())
    };
    let begin = value
        .0
        .iter()
        .position(|cp| !whitespace(cp))
        .unwrap_or(value.0.len());
    let end = value
        .0
        .iter()
        .rposition(|cp| !whitespace(cp))
        .map_or(begin, |i| i + 1);
    Text(value.0[begin..end].to_vec())
}
