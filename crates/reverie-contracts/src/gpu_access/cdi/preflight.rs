//! Full standalone device-node path DATA, preserving values that the queue's
//! numeric-node projection intentionally ignores. Serialization is deferred
//! until the caller completes the original metadata recheck sequence.
use super::*;

pub struct CdiPreflightEdits {
    document: CdiDocument,
    row: usize,
    edits: CdiSelectedEdits,
}
impl CdiDocument {
    pub fn into_preflight(self, device: &NvidiaCdiDevice) -> Result<Option<CdiPreflightEdits>> {
        let Some((row, edits)) = self.selected_index(device)? else {
            return Ok(None);
        };
        Ok(Some(CdiPreflightEdits {
            document: self,
            row,
            edits,
        }))
    }
}
impl CdiPreflightEdits {
    pub fn edits(&self) -> &CdiSelectedEdits {
        &self.edits
    }
    /// Python json.dumps-compatible, finite, ASCII path-list bytes. Unsupported
    /// YAML bytes/dates/sets remain a final report error, not an early CDI error.
    pub fn encode_paths(&self) -> Result<Vec<u8>> {
        let value = self.paths_value()?;
        if !value.is_finite() {
            return Err(GpuDataError::CdiDocument);
        }
        Ok(crate::worker_config::encode_data(&value))
    }
    pub(crate) fn paths_value(&self) -> Result<Value> {
        let mut paths = Vec::new();
        for node in self.document.combined(self.row, "deviceNodes")? {
            let node = node.ok_or(GpuDataError::CdiDocument)?;
            paths.push(match self.document.field(node, "path")? {
                None => Value(Node::Null),
                Some(index) => project(&self.document, index)?,
            });
        }
        Ok(Value(Node::Array(paths)))
    }
}
enum Step {
    Enter(usize),
    Array(usize),
    Map(Vec<Text>),
}
fn project(document: &CdiDocument, root: usize) -> Result<Value> {
    let mut steps = vec![Step::Enter(root)];
    let mut values = Vec::new();
    while let Some(step) = steps.pop() {
        match step {
            Step::Array(count) => {
                let children = values.split_off(values.len() - count);
                values.push(Value(Node::Array(children)));
            }
            Step::Map(keys) => {
                let children = values.split_off(values.len() - keys.len());
                values.push(Value(Node::Object(
                    keys.into_iter().zip(children).collect(),
                )));
            }
            Step::Enter(index) => match &document.nodes[index] {
                CdiValue::Primitive(value) => values.push(value.deep_clone()),
                CdiValue::YamlInteger(raw) => values.push(Value(Node::Number(Number::Integer(
                    scalar::integer_value(raw)?,
                )))),
                CdiValue::Text(value) => {
                    values.push(Value(Node::String(Text(value.codepoints().to_vec()))))
                }
                CdiValue::List(children) | CdiValue::Tuple(children) => {
                    steps.push(Step::Array(children.len()));
                    steps.extend(children.iter().rev().copied().map(Step::Enter));
                }
                CdiValue::Map(children) => {
                    steps.push(Step::Map(
                        children
                            .keys()
                            .map(|key| Text(key.codepoints().to_vec()))
                            .collect(),
                    ));
                    steps.extend(children.values().rev().copied().map(Step::Enter));
                }
                // Atom represents a constructed timestamp, or an unused raw
                // placeholder. Neither is an encodable selected path value.
                CdiValue::Atom | CdiValue::Bytes(_) | CdiValue::Set(_) => {
                    return Err(GpuDataError::CdiDocument);
                }
            },
        }
    }
    Ok(values.pop().expect("one projected CDI value"))
}
