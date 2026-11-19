//! Existing dream reply fields, prose fallback, and screening order.
use super::*;
use crate::legacy_json::{decode_memory_cli_text, ordered::OrderNode};
use reverie_core::{PythonText, PythonTextRef, memory::DreamTone, python_regex::space};

pub struct DreamReply {
    pub dream: MetadataText,
    pub recall: MetadataText,
    pub tone: DreamTone,
    pub ideas: Vec<DreamIdea>,
}

pub struct DreamIdea {
    pub hypothesis: MetadataText,
    pub check: MetadataText,
}

pub fn dream_reply<E>(
    raw: &PythonText,
    mut permits: impl FnMut(&MetadataText) -> std::result::Result<bool, E>,
) -> std::result::Result<Option<DreamReply>, E> {
    let (mut dream, recall, tone, candidates) = json_object(raw)
        .as_ref()
        .map_or_else(empty_response, response_fields);
    let mut ideas = Vec::new();
    for idea in candidates {
        if permits(&idea.hypothesis)? && permits(&idea.check)? {
            ideas.push(idea);
        }
    }
    if dream.codepoints().is_empty() {
        dream = collapse(
            raw.codepoints()
                .iter()
                .copied()
                .filter(|&point| point != u32::from('*')),
        );
        dream = limited(&dream, 900);
    }
    if dream.codepoints().len() < 20 || !permits(&dream)? || !permits(&recall)? {
        return Ok(None);
    }
    Ok(Some(DreamReply {
        recall: limited(&dream_recall(&dream, recall), 240),
        dream: limited(&dream, 1200),
        tone,
        ideas,
    }))
}

fn empty_response() -> (MetadataText, MetadataText, DreamTone, Vec<DreamIdea>) {
    (
        MetadataText::from_scalar_text(""),
        MetadataText::from_scalar_text(""),
        DreamTone::default(),
        Vec::new(),
    )
}

fn json_object(raw: &PythonText) -> Option<OrderedValue> {
    let points = raw.codepoints();
    let start = points.iter().position(|&p| p == u32::from('{'))?;
    let end = points.iter().rposition(|&p| p == u32::from('}'))?;
    let value =
        decode_memory_cli_text(PythonTextRef::from_codepoints(points.get(start..=end)?).ok()?)
            .ok()?;
    matches!(value.value.0, Node::Object(_)).then_some(value)
}

fn child(value: &OrderedValue, key: &str) -> Option<OrderedValue> {
    let key = text(key);
    let Node::Object(values) = &value.value.0 else {
        return None;
    };
    Some(OrderedValue {
        value: values.get(&key)?.deep_clone(),
        graph: value.graph.with_root(value.root_child_index(&key)?),
    })
}

fn response_fields(
    fields: &OrderedValue,
) -> (MetadataText, MetadataText, DreamTone, Vec<DreamIdea>) {
    let tone = child(fields, "tone")
        .and_then(|value| {
            let tone = MetadataText::from_text(value.python_string());
            let tone = tone.as_python_text_ref().trimmed().into_owned().lowercase();
            DreamTone::ALL
                .into_iter()
                .find(|value| tone.equals_ascii(value.as_str()))
        })
        .unwrap_or_default();
    (
        cleaned_field(fields, "dream"),
        cleaned_field(fields, "recall"),
        tone,
        child(fields, "ideas").map_or_else(Vec::new, |value| ideas(&value)),
    )
}

fn ideas(value: &OrderedValue) -> Vec<DreamIdea> {
    let Node::Array(items) = &value.value.0 else {
        return Vec::new();
    };
    let OrderNode::Array(order) = &value.graph.nodes[value.graph.root] else {
        unreachable!("ordered dream ideas");
    };
    items
        .iter()
        .zip(order)
        .take(3)
        .filter_map(|(item, &root)| {
            let fields = OrderedValue {
                value: item.deep_clone(),
                graph: value.graph.with_root(root),
            };
            let hypothesis = limited(&cleaned_field(&fields, "hypothesis"), 500);
            let check = limited(&cleaned_field(&fields, "check"), 500);
            (!hypothesis.codepoints().is_empty() && !check.codepoints().is_empty())
                .then_some(DreamIdea { hypothesis, check })
        })
        .collect()
}

fn cleaned_field(value: &OrderedValue, key: &str) -> MetadataText {
    collapse(
        child(value, key)
            .into_iter()
            .flat_map(|field| field.python_string().0),
    )
}

fn collapse(points: impl Iterator<Item = u32>) -> MetadataText {
    let mut output = Vec::new();
    let mut separating = false;
    for point in points {
        if space(point) {
            separating = !output.is_empty();
        } else {
            if separating {
                output.push(u32::from(' '));
            }
            output.push(point);
            separating = false;
        }
    }
    MetadataText::from_text(Text(output))
}

fn limited(text: &MetadataText, limit: usize) -> MetadataText {
    MetadataText::from_python_text(text.as_python_text_ref().take(limit).into_owned())
}

fn dream_recall(dream: &MetadataText, recall: MetadataText) -> MetadataText {
    let Some((&first, rest)) = recall.codepoints().split_first() else {
        let snippet = dream.as_python_text_ref().take(120).codepoints();
        let end = snippet
            .iter()
            .rposition(|point| !matches!(point, 32 | 44 | 46 | 59))
            .map_or(0, |i| i + 1);
        let output = "I dreamed something strange: "
            .chars()
            .map(u32::from)
            .chain(snippet[..end].iter().copied())
            .chain([46; 3])
            .collect();
        return MetadataText::from_text(Text(output));
    };
    let lcase = recall.as_python_text_ref().into_owned().lowercase();
    if lcase
        .codepoints()
        .iter()
        .copied()
        .take(7)
        .eq("i dream".chars().map(u32::from))
    {
        return recall;
    }
    let lowered = PythonText::try_new(vec![first])
        .expect("valid recall")
        .lowercase();
    MetadataText::from_text(Text(
        "I dreamed "
            .chars()
            .map(u32::from)
            .chain(lowered.into_codepoints())
            .chain(rest.iter().copied())
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::convert::Infallible;

    #[test]
    fn decodes_surrogates_coerces_json_and_screens_text_and_ideas_separately() {
        let input = PythonText::from_scalar_text(
            r#"preamble {"dream":"A long enough dream with \ud800 in it","recall":"İ drift","tone":"  WARM ","ideas":[{"hypothesis":"omit","check":"confirmation"},{"hypothesis":42,"check":"  verify\u0085now"}]} trailing"#,
        );
        let data = dream_reply(&input, |text| {
            Ok::<_, Infallible>(text.scalar_text().as_deref() != Some("omit"))
        })
        .unwrap()
        .unwrap();
        assert!(data.dream.codepoints().contains(&0xd800));
        assert_eq!(
            data.recall.scalar_text().unwrap(),
            "I dreamed i\u{307} drift"
        );
        assert_eq!(data.tone, DreamTone::Warm);
        assert_eq!(data.ideas.len(), 1);
        assert_eq!(data.ideas[0].hypothesis.scalar_text().unwrap(), "42");
        assert_eq!(data.ideas[0].check.scalar_text().unwrap(), "verify now");
    }

    #[test]
    fn prose_fallback_strips_markup_and_applies_screening_before_creating_recall() {
        let draft = |value: &str| {
            dream_reply(&PythonText::from_scalar_text(value), |text| {
                Ok::<_, Infallible>(text.scalar_text().is_some_and(|s| !s.contains("refused")))
            })
            .unwrap()
        };
        assert!(draft("short").is_none());
        assert!(draft("A longer response with a refused term").is_none());
        let data = draft("**I walked** over a bridge.").unwrap();
        assert_eq!(data.dream.scalar_text().unwrap(), "I walked over a bridge.");
        assert_eq!(
            data.recall.scalar_text().unwrap(),
            "I dreamed something strange: I walked over a bridge..."
        );
        assert_eq!(data.tone, DreamTone::Strange);
    }
}
