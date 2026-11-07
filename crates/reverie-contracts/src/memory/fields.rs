use super::*;
use crate::legacy_json::{self, truthy};
#[derive(Clone)]
pub struct MemoryMetadata(pub(super) OrderedValue);
#[derive(Clone)]
pub struct MemorySources(pub(super) OrderedValue);
impl Default for MemoryMetadata {
    fn default() -> Self {
        Self(object(Vec::new()))
    }
}
impl MemoryMetadata {
    pub fn decode(raw: &str) -> Result<Self> {
        Ok(Self(
            legacy_json::decode_memory_str(raw.as_bytes())
                .map_err(|_| MemoryJsonError::InvalidJson)?,
        ))
    }
    pub fn json(&self) -> String {
        String::from_utf8(self.0.encode()).expect("ASCII JSON")
    }
    pub fn or_empty(self) -> Self {
        if truthy(Some(&self.0.value)) {
            self
        } else {
            Self::default()
        }
    }
    pub fn with_released(&self, released: bool) -> Result<Self> {
        let mut result = self.clone();
        if !result
            .0
            .insert_root_field(text("released"), Value(Node::Bool(released)))
        {
            return Err(MemoryJsonError::ExpectedObject);
        }
        Ok(result)
    }
    pub fn external_episode(source: &str, visibility: &str) -> Self {
        Self::external_episode_text(
            &MetadataText::from_scalar_text(source),
            &MetadataText::from_scalar_text(visibility),
        )
    }
    pub fn external_episode_text(source: &MetadataText, visibility: &MetadataText) -> Self {
        Self(object(vec![
            ("external_source", embedding::codepoint_string(source)),
            ("visibility", embedding::codepoint_string(visibility)),
        ]))
    }
    pub fn dream(recall: &str, tone: &str, ideas: Option<&Self>) -> Self {
        Self::dream_text(
            &MetadataText::from_scalar_text(recall),
            &MetadataText::from_scalar_text(tone),
            ideas,
        )
    }
    pub fn dream_text(recall: &MetadataText, tone: &MetadataText, ideas: Option<&Self>) -> Self {
        let mut fields = vec![
            ("recall", embedding::codepoint_string(recall)),
            ("tone", embedding::codepoint_string(tone)),
            ("released", boolean(false)),
        ];
        if let Some(ideas) = ideas
            && truthy(Some(&ideas.0.value))
        {
            fields.push(("ideas", ideas.0.clone()));
        }
        fields.push(("summary_only", boolean(true)));
        Self(object(fields))
    }
    pub fn project(project: &str, source: &str) -> Self {
        Self::project_text(project, &MetadataText::from_scalar_text(source))
    }
    pub fn project_text(project: &str, source: &MetadataText) -> Self {
        Self(object(vec![
            ("project", string(project)),
            ("source", embedding::codepoint_string(source)),
            ("visibility", string("project")),
        ]))
    }
    pub fn legacy_history(idle: bool) -> Self {
        Self(object(vec![
            ("idle", boolean(idle)),
            ("legacy", boolean(true)),
        ]))
    }
    pub(super) fn idle(&self) -> Result<bool> {
        let Node::Object(fields) = &self.0.value.0 else {
            return Err(MemoryJsonError::ExpectedObject);
        };
        Ok(truthy(fields.get(&text("idle"))))
    }
    pub(super) fn recall(&self, fallback: &str) -> Result<MetadataText> {
        let Node::Object(fields) = &self.0.value.0 else {
            return Err(MemoryJsonError::ExpectedObject);
        };
        let Some(value) = fields
            .get(&text("recall"))
            .filter(|value| truthy(Some(value)))
        else {
            return Ok(MetadataText::from_text(text(fallback)));
        };
        let index = self
            .0
            .root_child_index(&text("recall"))
            .expect("private ordered metadata field");
        Ok(MetadataText::from_text(
            OrderedValue {
                value: value.deep_clone(),
                graph: self.0.graph.with_root(index),
            }
            .python_string(),
        ))
    }
}
impl MemorySources {
    /// Existing add_reflection/add_dream perform list(source_ids) before
    /// embedding. Preserve integer width and Python iteration of JSON data.
    pub fn iterated(&self) -> Result<Self> {
        use crate::legacy_json::ordered::OrderNode;
        let items = match &self.0.value.0 {
            Node::Array(_) => return Ok(self.clone()),
            Node::String(value) => value
                .0
                .iter()
                .map(|&cp| OrderedValue::scalar(Value(Node::String(Text(vec![cp])))))
                .collect(),
            Node::Object(_) => {
                let OrderNode::Object(fields) = &self.0.graph.nodes[self.0.graph.root] else {
                    unreachable!("private source field order")
                };
                fields
                    .iter()
                    .map(|(key, _)| OrderedValue::scalar(Value(Node::String(key.clone()))))
                    .collect()
            }
            _ => return Err(MemoryJsonError::ExpectedSourcesIterable),
        };
        Ok(Self(OrderedValue::array(items)))
    }
    pub fn new(ids: &[i64]) -> Self {
        Self(OrderedValue::array(
            ids.iter().copied().map(integer).collect(),
        ))
    }
    pub fn decode(raw: &str) -> Result<Self> {
        Ok(Self(
            legacy_json::decode_memory_str(raw.as_bytes())
                .map_err(|_| MemoryJsonError::InvalidJson)?,
        ))
    }
    pub fn json(&self) -> String {
        String::from_utf8(self.0.encode()).expect("ASCII JSON")
    }
}
