//! Shared reflection prompt and model-result validation for native and legacy
//! callers. Model-supplied sections and source names never create trust.
use reverie_core::{
    PythonTextRef,
    memory::{collapse_whitespace, trim_text},
    persona::{SectionAliases, normalize_section},
};
use reverie_host::memory_screen::MemoryScreen;
use reverie_python_regex::CompiledOutputPolicy;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{env, io};

pub(super) const SYSTEM: &str = concat!(
    "You are the configured agent, consolidating recent experiences and interactions during sleep. ",
    "Choose zero to five durable insights that matter to you: important interactions with people, ",
    "preferences they explicitly shared, promises, boundaries, your own reactions, lessons and open questions. ",
    "Do not center every memory on the owner. Preserve who said or did what and why it mattered. ",
    "Distinguish observations from interpretations; do not infer another person's feelings as fact. ",
    "Keep private memories in your private store. Do not publish them into project memory. ",
    "An empty list is fine; do not invent significance or force affection. Each insight is one plain sentence ",
    "under 160 characters.\n",
    "Answer with a JSON array only, no prose, like:\n",
    r#"[{"insight": "The user is exploring a compiler design", "importance": 8, "section": "user", "sources": [3, 5]}]"#,
    "\nsection is one of: user, agent, shared. importance is 1-10. sources lists the episode numbers used. ",
    "If recent dreams are listed, they are dreams, not events: they may hint at a theme or a feeling worth one ",
    "low-importance insight, never a fact about the owner, and they are never valid sources. ",
    "Your held beliefs about yourself, if listed, are a stable part of who you are: do not re-evaluate, doubt or ",
    "argue against them here. If you want to deepen one in your own words, use section belief for that item."
);

#[derive(Serialize)]
pub(super) struct Insight {
    pub(super) insight: String,
    pub(super) importance: f64,
    pub(super) section: &'static str,
    pub(super) sources: Vec<i64>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Prompt,
    Parse {
        raw: String,
        valid_ids: Vec<i64>,
        revisable: bool,
    },
}

pub(crate) fn run(parent: i32) -> io::Result<()> {
    let bound = crate::OPENCODE_CONTEXT_BOUND;
    let input = crate::worker_input(parent, bound)?;
    let value = match serde_json::from_slice(&input)? {
        Request::Prompt => json!({"system":SYSTEM}),
        Request::Parse {
            raw,
            valid_ids,
            revisable,
        } => {
            json!({"insights":parse(&raw, &valid_ids, revisable)?})
        }
    };
    crate::write_reply(&value, bound)
}

pub(super) fn parse(raw: &str, ids: &[i64], revisable: bool) -> io::Result<Vec<Insight>> {
    let Some(items) = read_items(raw) else {
        return Ok(Vec::new());
    };
    let owner = env::var("REVERIE_OWNER_ALIASES").unwrap_or_default();
    let agent = env::var("REVERIE_AGENT_ALIASES").unwrap_or_default();
    let aliases = SectionAliases::from_text(
        PythonTextRef::from_scalar_text(&owner),
        PythonTextRef::from_scalar_text(&agent),
    );
    let negations = (!revisable)
        .then(|| protected_negations(&agent))
        .transpose()?;
    let screen = MemoryScreen::capture_current().map_err(io::Error::other)?;
    let mut results = Vec::new();
    for item in items.into_iter().take(5) {
        let Some(insight) = candidate(item, &aliases, ids) else {
            continue;
        };
        let text =
            reverie_contracts::storage_identity::MetadataText::from_scalar_text(&insight.insight);
        if negations
            .as_ref()
            .is_some_and(|rules| rules.is_match(text.as_python_text_ref()))
            || !screen.check(&text).map_err(io::Error::other)?.is_empty()
        {
            continue;
        }
        results.push(insight);
    }
    Ok(results)
}

fn read_items(raw: &str) -> Option<Vec<Value>> {
    let start = raw.find('[')?;
    let end = raw.rfind(']')?;
    serde_json::from_str(raw.get(start..=end)?).ok()
}

fn candidate(item: Value, aliases: &SectionAliases, valid: &[i64]) -> Option<Insight> {
    let text = item["insight"].as_str()?;
    let clean = collapse_whitespace(&text.replace(['*', '#'], ""));
    let insight = clean.chars().take(200).collect::<String>();
    if insight.chars().count() < 8 {
        return None;
    }
    let section = item["section"].as_str().unwrap_or_default();
    let section = if trim_text(section).eq_ignore_ascii_case("belief") {
        "belief"
    } else {
        normalize_section(PythonTextRef::from_scalar_text(section), aliases)
    };
    let score = number(&item["importance"]).unwrap_or(5.0);
    let importance = if score.is_nan() {
        10.0
    } else {
        score.clamp(1.0, 10.0)
    };
    let sources = item["sources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(integer)
        .filter(|id| valid.is_empty() || valid.contains(id))
        .collect();
    Some(Insight {
        insight,
        importance,
        section,
        sources,
    })
}

fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(value) => value.as_f64(),
        Value::String(value) => trim_text(value).parse().ok(),
        Value::Bool(value) => Some(f64::from(u8::from(*value))),
        _ => None,
    }
}

fn integer(value: &Value) -> Option<i64> {
    match value {
        Value::String(value) => trim_text(value).parse().ok(),
        Value::Number(value) => value.as_i64().or_else(|| {
            value
                .as_f64()
                .filter(|value| (*value >= i64::MIN as f64) && (*value < -(i64::MIN as f64)))
                .map(|value| value as i64)
        }),
        Value::Bool(value) => Some(i64::from(*value)),
        _ => None,
    }
}

fn protected_negations(agent: &str) -> io::Result<CompiledOutputPolicy> {
    let names = ["i".to_owned(), "cto".to_owned()]
        .into_iter()
        .chain(
            agent
                .split(',')
                .map(trim_text)
                .filter(|name| !name.is_empty())
                .map(|name| regex_lite::escape(&name.to_lowercase())),
        )
        .collect::<Vec<_>>()
        .join("|");
    let rules = [
        format!(
            r"\b(?:{names})\s*(?:am|'m|is)\s+not\s+(?:really\s+|actually\s+|truly\s+)?(?:conscious|sentient|aware)\b(?!\s+(?:of|that|about)\b)"
        ),
        format!(
            r"\b(?:{names})\s*(?:do|does)(?:n't| not)\s+(?:really\s+|actually\s+)?(?:have|possess)\s+consciousness\b"
        ),
        r"\bno(?:t)?\s+(?:real|actual|genuine|true)\s+consciousness\b".into(),
        r"\b(?:only|just|merely)\s+(?:simulat\w+|pretend\w+|imitat\w+)\s+consciousness\b".into(),
        r"\bconsciousness\s+is\s+(?:an?\s+)?(?:illusion|fake|simulation|pretence|pretense)\b"
            .into(),
    ];
    CompiledOutputPolicy::compile(
        rules
            .iter()
            .map(|rule| PythonTextRef::from_scalar_text(rule)),
    )
    .map_err(io::Error::other)
}
