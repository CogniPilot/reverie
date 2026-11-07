//! Public journal-client replies are data, not native completion/owner proof.
//! A successful process without the actual success/data envelope confirms no
//! save; malformed/lost replies remain failures instead of empty success.
use super::*;
pub struct JournalSaveData(Vec<u8>);
pub struct JournalEntries(Vec<u8>);
#[derive(Debug)]
pub enum JournalReplyError {
    Refused(MetadataText),
    Malformed,
}
impl std::fmt::Display for JournalReplyError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str(match self {
            Self::Refused(_) => "journal client refused",
            Self::Malformed => "journal client did not confirm a response",
        })
    }
}
impl std::error::Error for JournalReplyError {}
impl JournalSaveData {
    pub fn decode(
        stdout: &str,
        stderr: &str,
        succeeded: bool,
    ) -> std::result::Result<Self, JournalReplyError> {
        let data = envelope(stdout, stderr, succeeded)?;
        Ok(Self(data.encode()))
    }
    pub fn as_json(&self) -> &[u8] {
        &self.0
    }
}
impl JournalEntries {
    pub fn decode(
        stdout: &str,
        stderr: &str,
        succeeded: bool,
    ) -> std::result::Result<Self, JournalReplyError> {
        let data = envelope(stdout, stderr, succeeded)?;
        let Node::Object(fields) = &data.value.0 else {
            return Err(JournalReplyError::Malformed);
        };
        let value = fields
            .get(&key("entries"))
            .ok_or(JournalReplyError::Malformed)?;
        let index = data
            .root_child_index(&key("entries"))
            .expect("parsed named journal graph");
        Ok(Self(
            OrderedValue {
                value: value.deep_clone(),
                graph: data.graph.with_root(index),
            }
            .encode(),
        ))
    }
    pub fn as_json(&self) -> &[u8] {
        &self.0
    }
}
fn envelope(
    stdout: &str,
    stderr: &str,
    succeeded: bool,
) -> std::result::Result<OrderedValue, JournalReplyError> {
    let raw = legacy_json::decode_memory_cli_text(PythonTextRef::from_scalar_text(stdout));
    let parsed = raw
        .ok()
        .filter(|value| matches!(value.value.0, Node::Object(_)));
    let refused = parsed.as_ref().is_some_and(|data| {
        let Node::Object(fields) = &data.value.0 else {
            unreachable!()
        };
        matches!(
            fields.get(&key("success")).map(|value| &value.0),
            Some(Node::Bool(false))
        )
    });
    if !succeeded || refused {
        let message = parsed
            .as_ref()
            .and_then(|data| {
                let Node::Object(fields) = &data.value.0 else {
                    unreachable!()
                };
                truthy(fields.get(&key("error"))).then(|| field_string(data, "error", ""))
            })
            .unwrap_or_else(|| {
                let text = PythonTextRef::from_scalar_text(stderr)
                    .trimmed()
                    .into_owned();
                if text.codepoints().is_empty() {
                    MetadataText::from_scalar_text("journal unavailable")
                } else {
                    MetadataText::from_python_text(text)
                }
            });
        return Err(JournalReplyError::Refused(MetadataText::from_python_text(
            message.as_python_text_ref().take(500).into_owned(),
        )));
    }
    let data = parsed.ok_or(JournalReplyError::Malformed)?;
    let Node::Object(fields) = &data.value.0 else {
        unreachable!()
    };
    if !matches!(
        fields.get(&key("success")).map(|value| &value.0),
        Some(Node::Bool(true))
    ) {
        return Err(JournalReplyError::Malformed);
    }
    let value = fields
        .get(&key("data"))
        .ok_or(JournalReplyError::Malformed)?;
    let index = data
        .root_child_index(&key("data"))
        .expect("parsed named journal graph");
    Ok(OrderedValue {
        value: value.deep_clone(),
        graph: data.graph.with_root(index),
    })
}
pub struct MemoryReply(Vec<u8>);
impl MemoryReply {
    pub fn initialized() -> Self {
        Self(b"{\"initialized\": true}".to_vec())
    }
    pub fn error(message: &MetadataText) -> Self {
        Self(object("error", message))
    }
    pub fn screened(floor: &str) -> Self {
        Self(object("floor", &MetadataText::from_scalar_text(floor)))
    }
    pub fn recalled(memories: &[crate::memory::MemoryView]) -> Self {
        let mut result = vec![b'['];
        for (index, memory) in memories.iter().enumerate() {
            if index != 0 {
                result.extend_from_slice(b", ");
            }
            result.extend_from_slice(memory.as_json());
        }
        result.push(b']');
        Self(result)
    }
    pub fn saved(data: JournalSaveData) -> Self {
        Self(data.0)
    }
    pub fn recalled_with_journal(
        memories: &[crate::memory::MemoryView],
        entries: &JournalEntries,
    ) -> Self {
        Self::combined(
            memories,
            entries.as_json(),
            &MetadataText::from_scalar_text(
                "journal entries are your store of record; legacy results are older, read-only history",
            ),
        )
    }
    pub fn recalled_after_journal_refusal(
        memories: &[crate::memory::MemoryView],
        reason: &MetadataText,
    ) -> Self {
        let mut note = "journal lookup failed ("
            .chars()
            .map(u32::from)
            .collect::<Vec<_>>();
        note.extend_from_slice(reason.codepoints());
        note.extend(
            "); these are only older, read-only results from the old store"
                .chars()
                .map(u32::from),
        );
        Self::combined(memories, b"[]", &MetadataText::from_text(Text(note)))
    }
    fn combined(
        memories: &[crate::memory::MemoryView],
        entries: &[u8],
        note: &MetadataText,
    ) -> Self {
        let mut data = b"{\"journal\": ".to_vec();
        data.extend_from_slice(entries);
        data.extend_from_slice(b", \"legacy\": ");
        data.extend(Self::recalled(memories).0);
        data.extend_from_slice(b", \"note\": ");
        data.extend(quoted(note));
        data.push(b'}');
        Self(data)
    }
    pub fn as_json(&self) -> &[u8] {
        &self.0
    }
}
fn quoted(text: &MetadataText) -> Vec<u8> {
    OrderedValue::scalar(Value(Node::String(Text(text.codepoints().to_vec())))).encode()
}
fn object(name: &str, text: &MetadataText) -> Vec<u8> {
    OrderedValue::object(vec![(
        key(name),
        OrderedValue::scalar(Value(Node::String(Text(text.codepoints().to_vec())))),
    )])
    .encode()
}
