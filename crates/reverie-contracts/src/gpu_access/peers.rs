use super::*;
use crate::{
    legacy_json,
    storage_identity::{Metadata, MetadataText},
};
use reverie_core::ids::ProfileSessionId;
/// Source employee-array order, interpreted only after the proposed full
/// worker validation. It is not a second registry validator or trusted SID set.
pub struct GpuPeerSessions<'a> {
    rows: std::slice::Iter<'a, Value>,
    selected: &'a ProfileSessionId,
}
impl<'a> GpuPeerSessions<'a> {
    pub fn new(company: &'a Metadata, selected: &'a ProfileSessionId) -> Result<Self> {
        let Some(Value(Node::Array(rows))) =
            object(company.as_value()).and_then(|fields| field(fields, "employees"))
        else {
            return Err(GpuDataError::CurrentRegistry);
        };
        Ok(Self {
            rows: rows.iter(),
            selected,
        })
    }
}
impl Iterator for GpuPeerSessions<'_> {
    type Item = Result<MetadataText>;
    fn next(&mut self) -> Option<Self::Item> {
        for row in self.rows.by_ref() {
            let Some(row) = object(row) else {
                return Some(Err(GpuDataError::CurrentRegistry));
            };
            let session = field(row, "sessionId");
            if !legacy_json::truthy(session) {
                continue;
            }
            let Some(Value(Node::String(session))) = session else {
                return Some(Err(GpuDataError::CurrentRegistry));
            };
            if session.equals_ascii(self.selected.as_str()) {
                continue;
            }
            return Some(Ok(MetadataText::from_text(session.clone())));
        }
        None
    }
}
