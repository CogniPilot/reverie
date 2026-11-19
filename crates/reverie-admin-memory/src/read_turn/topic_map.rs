use super::{fits, reply, unavailable};
use serde_json::{Value, json};
use std::collections::BTreeSet;

const TAG_LIMIT: usize = 8;
const EDGE_LIMIT: usize = 6;

pub(super) fn settle(view: &Value, captured: &Value, failure: Option<&str>) -> Option<Value> {
    if super::empty(view) {
        return Some(unavailable(None, failure));
    }
    if view["status"] != "available" {
        let reason = view["reason"].as_str().unwrap_or("view_unavailable");
        return Some(unavailable(Some(reason), failure));
    }
    let scope = captured.get("room")?.as_str()?;
    if view.get("scope").is_some_and(|reported| reported != scope) {
        return None;
    }
    let tags = view["tags"].as_array()?;
    let edges = view["edges"].as_array()?;
    let result = json!({
        "status": "available",
        "scope": scope,
        "entries": view["entries"].as_array()?.iter().map(|row| fields(row, &["id", "currentness", "importance", "related", "provenance"])).collect::<Option<Vec<Value>>>()?,
        "tags": selected_tags(tags)?,
        "coverage": view.get("coverage")?,
        "map_bounded": tags.len() > TAG_LIMIT || edges.len() > EDGE_LIMIT,
        "meaning": "Topic co-occurrence, self-assessed importance and stated provenance; not causation, truth or authority",
    });
    let labels = result["tags"]
        .as_array()?
        .iter()
        .map(|tag| tag["label"].as_str())
        .collect::<Option<BTreeSet<_>>>()?;
    let selected_edges = edges
        .iter()
        .filter(|edge| {
            ["a", "b"].iter().all(|key| {
                edge[*key]
                    .as_str()
                    .is_some_and(|label| labels.contains(label))
            })
        })
        .take(EDGE_LIMIT)
        .map(|row| fields(row, &["a", "b", "count", "entry_ids"]))
        .collect::<Option<Vec<_>>>()?;
    let mut result = result;
    result["edges"] = json!(selected_edges);
    Some(if fits(&result) {
        reply(result)
    } else {
        unavailable(Some("map_result_budget; narrow query"), None)
    })
}

fn selected_tags(tags: &[Value]) -> Option<Vec<Value>> {
    let mut ranked = tags
        .iter()
        .map(|tag| Some((tag["count"].as_i64()?, tag["label"].as_str()?, tag)))
        .collect::<Option<Vec<_>>>()?;
    ranked.sort_by(|(a, label, _), (b, other, _)| b.cmp(a).then_with(|| label.cmp(other)));
    ranked
        .into_iter()
        .take(TAG_LIMIT)
        .map(|(_, _, row)| fields(row, &["label", "count", "entry_ids"]))
        .collect()
}

fn fields(value: &Value, allowed: &[&str]) -> Option<Value> {
    allowed
        .iter()
        .map(|key| Some(((*key).to_owned(), value.get(*key)?.clone())))
        .collect::<Option<serde_json::Map<_, _>>>()
        .map(Value::Object)
}
