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
        Self(object(vec![
            ("external_source", string(source)),
            ("visibility", string(visibility)),
        ]))
    }
    pub fn dream(recall: &str, tone: &str, ideas: Option<&Self>) -> Self {
        let mut fields = vec![
            ("recall", string(recall)),
            ("tone", string(tone)),
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
        Self(object(vec![
            ("project", string(project)),
            ("source", string(source)),
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
