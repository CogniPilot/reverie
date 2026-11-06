use super::*;
use libyaml_safer::{EventData, Parser, ScalarStyle};
mod construct;
enum RawValue {
    Scalar {
        value: String,
        tag: Option<String>,
        style: ScalarStyle,
    },
    List {
        children: Vec<usize>,
        tag: Option<String>,
    },
    Map {
        children: Vec<usize>,
        tag: Option<String>,
    },
}
pub(super) fn decode(raw: &[u8]) -> Result<CdiDocument> {
    let (text, restore) = yaml_text::input(raw)?;
    let mut parser = Parser::new();
    parser.set_input(text.as_bytes());
    let mut nodes = Vec::new();
    let mut stack = Vec::new();
    let mut root = None;
    let mut documents = 0;
    let mut anchors = BTreeSet::new();
    for event in parser {
        match event.map_err(|_| GpuDataError::CdiDocument)?.data {
            EventData::Alias { .. } => return Err(GpuDataError::CdiDocument),
            EventData::DocumentStart { .. } => {
                documents += 1;
                if documents > 1 {
                    return Err(GpuDataError::CdiDocument);
                }
            }
            EventData::Scalar {
                anchor,
                tag,
                value,
                style,
                ..
            } => {
                anchor_unique(anchor, &mut anchors)?;
                append(
                    RawValue::Scalar { value, tag, style },
                    &mut nodes,
                    &mut stack,
                    &mut root,
                )?;
            }
            EventData::SequenceStart { anchor, tag, .. } => {
                anchor_unique(anchor, &mut anchors)?;
                let index = append(
                    RawValue::List {
                        children: Vec::new(),
                        tag,
                    },
                    &mut nodes,
                    &mut stack,
                    &mut root,
                )?;
                stack.push(index);
            }
            EventData::MappingStart { anchor, tag, .. } => {
                anchor_unique(anchor, &mut anchors)?;
                let index = append(
                    RawValue::Map {
                        children: Vec::new(),
                        tag,
                    },
                    &mut nodes,
                    &mut stack,
                    &mut root,
                )?;
                stack.push(index);
            }
            EventData::SequenceEnd | EventData::MappingEnd => {
                stack.pop().ok_or(GpuDataError::CdiDocument)?;
            }
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err(GpuDataError::CdiDocument);
    }
    match root {
        Some(root) => construct::document(&nodes, root, &restore),
        None => Ok(CdiDocument {
            nodes: vec![CdiValue::Atom],
            root: 0,
        }),
    }
}
fn anchor_unique(anchor: Option<String>, seen: &mut BTreeSet<String>) -> Result<()> {
    if anchor.is_some_and(|name| !seen.insert(name)) {
        Err(GpuDataError::CdiDocument)
    } else {
        Ok(())
    }
}
fn append(
    node: RawValue,
    nodes: &mut Vec<RawValue>,
    stack: &mut [usize],
    root: &mut Option<usize>,
) -> Result<usize> {
    let index = nodes.len();
    if let Some(&parent) = stack.last() {
        match &mut nodes[parent] {
            RawValue::List { children, .. } | RawValue::Map { children, .. } => {
                children.push(index)
            }
            _ => unreachable!("parser composite stack"),
        }
    } else if root.replace(index).is_some() {
        return Err(GpuDataError::CdiDocument);
    }
    nodes.push(node);
    Ok(index)
}
