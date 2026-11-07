use super::*;
enum Step {
    Enter(usize),
    Map(usize, bool),
    List(usize),
    Pairs(usize),
}
pub(super) fn document(
    raw: &[RawValue],
    root: usize,
    restore: &yaml_text::Restoration,
) -> Result<CdiDocument> {
    let mut nodes = (0..raw.len()).map(|_| CdiValue::Atom).collect::<Vec<_>>();
    let mut steps = vec![Step::Enter(root)];
    while let Some(step) = steps.pop() {
        match step {
            Step::Enter(index) => enter(raw, index, restore, &mut nodes, &mut steps)?,
            Step::Map(index, set) => nodes[index] = mapping(raw, index, set, &nodes)?,
            Step::List(index) => {
                let RawValue::List { children, .. } = &raw[index] else {
                    unreachable!("list task")
                };
                nodes[index] = CdiValue::List(children.clone());
            }
            Step::Pairs(index) => {
                finish_pairs(raw, index, &mut nodes);
            }
        }
    }
    Ok(CdiDocument { nodes, root })
}
fn enter(
    raw: &[RawValue],
    index: usize,
    restore: &yaml_text::Restoration,
    nodes: &mut [CdiValue],
    steps: &mut Vec<Step>,
) -> Result<()> {
    let tag = match &raw[index] {
        RawValue::Scalar { tag, .. } | RawValue::List { tag, .. } | RawValue::Map { tag, .. } => {
            tag.as_deref()
        }
    };
    let default = match &raw[index] {
        RawValue::Scalar { .. } => "str",
        RawValue::List { .. } => "seq",
        RawValue::Map { .. } => "map",
    };
    let kind = tag
        .filter(|tag| *tag != "!")
        .map(|tag| {
            tag.strip_prefix("tag:yaml.org,2002:")
                .ok_or(GpuDataError::CdiDocument)
        })
        .transpose()?
        .unwrap_or(default);
    match &raw[index] {
        RawValue::Scalar { value, tag, style } => {
            nodes[index] = scalar::construct(value, tag.as_deref(), *style, restore)?
        }
        RawValue::List { children, .. } if matches!(kind, "seq" | "omap" | "pairs") => {
            if kind == "seq" {
                steps.push(Step::List(index));
                schedule(children, steps);
            } else {
                steps.push(Step::Pairs(index));
                schedule_pairs(raw, children, steps)?;
            }
        }
        RawValue::Map { children, .. } if matches!(kind, "map" | "set") => {
            steps.push(Step::Map(index, kind == "set"));
            schedule(children, steps);
        }
        RawValue::Map { .. } => {
            // This one SafeConstructor matches node.value itself (a mapping
            // list), rather than its construct_scalar result, and therefore
            // refuses a MappingNode even with the special '=' value child.
            if kind == "timestamp" {
                return Err(GpuDataError::CdiDocument);
            }
            // SafeConstructor.construct_scalar accepts a MappingNode only via
            // its special '='-tagged value. Unselected children of that special
            // representation are not constructed by Python either.
            let value = scalar_value(raw, index)?;
            nodes[index] = scalar::construct(value, tag, ScalarStyle::Plain, restore)?;
        }
        _ => return Err(GpuDataError::CdiDocument),
    }
    Ok(())
}
fn schedule(children: &[usize], steps: &mut Vec<Step>) {
    steps.extend(children.iter().rev().map(|&index| Step::Enter(index)));
}
fn scalar_value(raw: &[RawValue], mut index: usize) -> Result<&str> {
    loop {
        match &raw[index] {
            RawValue::Scalar { value, .. } => return Ok(value),
            RawValue::Map { children, .. } => {
                index = value_child(raw, children)?;
            }
            _ => return Err(GpuDataError::CdiDocument),
        }
    }
}
fn finish_pairs(raw: &[RawValue], index: usize, nodes: &mut [CdiValue]) {
    let RawValue::List { children, .. } = &raw[index] else {
        unreachable!("pairs task")
    };
    for &child in children {
        let RawValue::Map { children, .. } = &raw[child] else {
            unreachable!("checked pair mapping")
        };
        nodes[child] = CdiValue::Tuple(children.clone());
    }
    nodes[index] = CdiValue::List(children.clone());
}
fn schedule_pairs(raw: &[RawValue], children: &[usize], steps: &mut Vec<Step>) -> Result<()> {
    for &child in children.iter().rev() {
        let RawValue::Map { children, .. } = &raw[child] else {
            return Err(GpuDataError::CdiDocument);
        };
        if children.len() != 2 {
            return Err(GpuDataError::CdiDocument);
        }
        schedule(children, steps);
    }
    Ok(())
}
fn value_child(raw: &[RawValue], children: &[usize]) -> Result<usize> {
    for pair in children.chunks_exact(2) {
        if let RawValue::Scalar { value, tag, style } = &raw[pair[0]]
            && scalar::kind(value, tag.as_deref(), *style)? == "value"
        {
            return Ok(pair[1]);
        }
    }
    Err(GpuDataError::CdiDocument)
}
fn mapping(raw: &[RawValue], index: usize, set: bool, nodes: &[CdiValue]) -> Result<CdiValue> {
    let RawValue::Map { children, .. } = &raw[index] else {
        unreachable!("mapping task")
    };
    if !children.len().is_multiple_of(2) {
        return Err(GpuDataError::CdiDocument);
    }
    let mut fields = BTreeMap::new();
    for pair in children.chunks_exact(2) {
        let CdiValue::Text(name) = &nodes[pair[0]] else {
            return Err(GpuDataError::CdiDocument);
        };
        if fields.insert(name.clone(), pair[1]).is_some() {
            return Err(GpuDataError::CdiDocument);
        }
    }
    Ok(if set {
        CdiValue::Set(fields.into_keys().collect())
    } else {
        CdiValue::Map(fields)
    })
}
