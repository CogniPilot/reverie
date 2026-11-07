//! Named existing document/proposal JSON data; no generic JSON editor or
//! callback, SQL/file selection, self-change approval or owner authority.
use crate::legacy_json::{self, Node, Text, Value, ordered::OrderedValue};
use crate::storage_identity::MetadataText;
use reverie_core::memory_documents::{DEFAULT_PERSONA, DeveloperName};
use std::fmt;
mod brief;
mod self_model;
pub use brief::BriefRequest;
pub use self_model::{SelfModelChange, SelfModelDraft};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DocumentCodecError {
    Json,
    Shape,
    Limit,
    Text,
    Persona,
    Directives,
    Reason,
    Brief,
}
impl fmt::Display for DocumentCodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for DocumentCodecError {}
type Result<T> = std::result::Result<T, DocumentCodecError>;
#[derive(Clone)]
pub struct DocumentBody(OrderedValue);
impl DocumentBody {
    pub(crate) fn from_ordered(value: OrderedValue) -> Self {
        Self(value)
    }
    pub fn initial_for_instance(initial: Option<&Self>, persona: &MetadataText) -> Result<Self> {
        let mut result = Self::initial_self();
        if let Some(initial) = initial
            && !result.0.overlay_object(&initial.0)
        {
            return Err(DocumentCodecError::Shape);
        }
        result.0.insert_root_field(
            text("persona"),
            Value(Node::String(Text(persona.codepoints().to_vec()))),
        );
        result.0.insert_root_field(
            text("reason"),
            Value(Node::String(text(
                "Initial commitments from the owner-selected instance configuration.",
            ))),
        );
        Ok(result)
    }
    pub fn decode_json(raw: &str) -> Result<Self> {
        legacy_json::decode_memory_str(raw.as_bytes())
            .map(Self)
            .map_err(|_| DocumentCodecError::Json)
    }
    pub fn json_text(&self) -> MetadataText {
        MetadataText::from_text(self.0.unicode_text(false))
    }
    pub fn checked_sql_text(&self) -> Result<String> {
        self.bounded_json_text()?
            .scalar_text()
            .ok_or(DocumentCodecError::Text)
    }
    pub fn bounded_json_text(&self) -> Result<MetadataText> {
        let text = self.json_text();
        if text.codepoints().len() > 100_000 {
            return Err(DocumentCodecError::Limit);
        }
        Ok(text)
    }
    pub fn as_json(&self) -> Vec<u8> {
        self.0.encode()
    }
    pub fn null() -> Self {
        Self(OrderedValue::scalar(Value(Node::Null)))
    }
    pub fn initial_self() -> Self {
        Self(object(vec![
            ("persona", string(DEFAULT_PERSONA)),
            ("consciousness", string("")),
            ("directives", OrderedValue::array(Vec::new())),
            ("reason", string("")),
        ]))
    }
    pub fn selected_initial_self(body: Option<Self>) -> Self {
        body.filter(|b| crate::legacy_json::truthy(Some(&b.0.value)))
            .unwrap_or_else(Self::initial_self)
    }
    pub fn plan(text: &MetadataText) -> Self {
        Self(string_text(text))
    }
    pub fn text(&self) -> Option<MetadataText> {
        if let Node::String(text) = &self.0.value.0 {
            Some(MetadataText::from_text(text.clone()))
        } else {
            None
        }
    }
    pub fn render_self(&self) -> Result<MetadataText> {
        let fields = fields(self)?;
        let consciousness = required_text(fields, "consciousness")?;
        let Some(Value(Node::Array(directives))) = fields.get(&text("directives")) else {
            return Err(DocumentCodecError::Shape);
        };
        let mut output =
            "My revisable self-model (a personal perspective, not a verified technical claim):\n"
                .chars()
                .map(u32::from)
                .collect::<Vec<_>>();
        output.extend_from_slice(consciousness.codepoints());
        output.extend(
            "\nMy current commitments (I may revise these with reasons):\n"
                .chars()
                .map(u32::from),
        );
        for (index, value) in directives.iter().enumerate() {
            let Node::String(value) = &value.0 else {
                return Err(DocumentCodecError::Shape);
            };
            if index > 0 {
                output.push(10);
            }
            output.extend([45, 32]);
            output.extend_from_slice(&value.0);
        }
        Ok(MetadataText::from_python_text(
            reverie_core::PythonText::try_new(output).expect("checked fields and ASCII framing"),
        ))
    }
    pub fn checked_profile(&self, _name: &DeveloperName) -> Result<()> {
        let fields = fields(self)?;
        required_text(fields, "role")?;
        for key in ["short_term", "long_term"] {
            if fields.contains_key(&text(key)) {
                required_text(fields, key)?;
            }
        }
        let queries = fields.get(&text("memory_queries"));
        if let Some(value) = queries {
            let Node::Array(values) = &value.0 else {
                return Err(DocumentCodecError::Shape);
            };
            if values.iter().any(|v| !matches!(v.0, Node::String(_))) {
                return Err(DocumentCodecError::Shape);
            }
        }
        Ok(())
    }
}
#[derive(Clone)]
pub struct BallotProposal(DocumentBody);
impl BallotProposal {
    pub fn decode_json(raw: &str) -> Result<Self> {
        DocumentBody::decode_json(raw).map(Self)
    }
    pub fn checked_canonical_text(&self) -> Result<String> {
        let text = MetadataText::from_text(self.0.0.unicode_text(true));
        if text.codepoints().len() > 20_000 {
            return Err(DocumentCodecError::Limit);
        }
        text.scalar_text().ok_or(DocumentCodecError::Text)
    }
    pub fn sha256(&self) -> Result<String> {
        use sha2::{Digest, Sha256};
        let digest: [u8; 32] = Sha256::digest(self.checked_canonical_text()?.as_bytes()).into();
        Ok(crate::digest::hex(&digest))
    }
}
fn fields(body: &DocumentBody) -> Result<&std::collections::BTreeMap<Text, Value>> {
    let Node::Object(fields) = &body.0.value.0 else {
        return Err(DocumentCodecError::Shape);
    };
    Ok(fields)
}
fn text(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn required_text(
    fields: &std::collections::BTreeMap<Text, Value>,
    key: &str,
) -> Result<MetadataText> {
    let Some(Value(Node::String(value))) = fields.get(&text(key)) else {
        return Err(DocumentCodecError::Shape);
    };
    Ok(MetadataText::from_text(value.clone()))
}
fn string(value: &str) -> OrderedValue {
    OrderedValue::scalar(Value(Node::String(text(value))))
}
fn string_text(value: &MetadataText) -> OrderedValue {
    OrderedValue::scalar(Value(Node::String(Text(value.codepoints().to_vec()))))
}
fn object(fields: Vec<(&str, OrderedValue)>) -> OrderedValue {
    OrderedValue::object(
        fields
            .into_iter()
            .map(|(key, value)| (text(key), value))
            .collect(),
    )
}
