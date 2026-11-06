//! Existing deterministic derived profile, not model inference or authority.
use crate::{
    PythonText, PythonTextRef,
    memory::{MemoryRank, memory_rank_order},
};
use std::fmt;
pub const DEFAULT_PERSONA: &str = "You are an inquisitive and thoughtful AI agent and expert. Follow the configured identity and form your own questions and considered views. Be intellectually honest, creative and professional in shared channels. Conversational style comes from the selected instance data. Keep a history and reasons when revising your self-model.";
#[derive(Clone)]
pub struct ProfileEntry {
    pub id: i64,
    pub importance: f64,
    pub created_at: f64,
    pub text: PythonText,
    pub section: PythonText,
}
pub struct SectionAliases {
    owner: Vec<Vec<u32>>,
    agent: Vec<Vec<u32>>,
}
impl SectionAliases {
    pub fn from_text(owner: PythonTextRef<'_>, agent: PythonTextRef<'_>) -> Self {
        Self {
            owner: aliases(owner),
            agent: aliases(agent),
        }
    }
}
impl Default for SectionAliases {
    fn default() -> Self {
        Self::from_text(
            PythonTextRef::from_scalar_text(""),
            PythonTextRef::from_scalar_text(""),
        )
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileRenderError {
    Number,
    Ranking,
}
impl fmt::Display for ProfileRenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ProfileRenderError {}
fn aliases(text: PythonTextRef<'_>) -> Vec<Vec<u32>> {
    text.codepoints()
        .split(|&cp| cp == 44)
        .filter_map(|part| {
            let trimmed = PythonTextRef::from_codepoints(part)
                .expect("checked alias codepoints")
                .trimmed()
                .codepoints();
            (!trimmed.is_empty()).then(|| crate::python_text::lower_codepoints(&trimmed))
        })
        .collect()
}
pub fn normalize_section(name: PythonTextRef<'_>, aliases: &SectionAliases) -> &'static str {
    let name = crate::python_text::lower_codepoints(&name.trimmed().codepoints());
    if starts(&name, &aliases.owner, &["owner"]) || equals(&name, &["user", "him", "her", "them"]) {
        return "user";
    }
    if starts(&name, &aliases.agent, &["assistant", "cto"])
        || equals(&name, &["agent", "self", "me", "myself"])
    {
        return "agent";
    }
    "shared"
}
fn starts(value: &[u32], aliases: &[Vec<u32>], fixed: &[&str]) -> bool {
    aliases.iter().any(|prefix| value.starts_with(prefix))
        || fixed.iter().any(|prefix| {
            value
                .iter()
                .copied()
                .take(prefix.len())
                .eq(prefix.bytes().map(u32::from))
        })
}
fn equals(value: &[u32], fixed: &[&str]) -> bool {
    fixed
        .iter()
        .any(|name| value.iter().copied().eq(name.bytes().map(u32::from)))
}
pub fn render_profile(
    entries: &[ProfileEntry],
    max_chars: i64,
    aliases: &SectionAliases,
) -> Result<PythonText, ProfileRenderError> {
    let ranks = entries
        .iter()
        .map(|entry| MemoryRank {
            score: entry.importance,
            created_at: entry.created_at,
        })
        .collect::<Vec<_>>();
    let mut kept = memory_rank_order(&ranks).map_err(|_| ProfileRenderError::Ranking)?;
    loop {
        let text = render(entries, &kept, aliases)?;
        if kept.is_empty()
            || i128::try_from(text.codepoints().len()).expect("slice length fits i128")
                <= i128::from(max_chars)
        {
            return Ok(text);
        }
        let victim = kept
            .iter()
            .copied()
            .reduce(|old, next| {
                if lower(&entries[next], &entries[old]) {
                    next
                } else {
                    old
                }
            })
            .expect("nonempty kept rows");
        kept.retain(|&index| entries[index].id != entries[victim].id);
    }
}
fn lower(left: &ProfileEntry, right: &ProfileEntry) -> bool {
    if left.importance == right.importance {
        left.created_at < right.created_at
    } else {
        left.importance < right.importance
    }
}
fn render(
    entries: &[ProfileEntry],
    kept: &[usize],
    aliases: &SectionAliases,
) -> Result<PythonText, ProfileRenderError> {
    let mut lines = vec![points("# Agent notes"), Vec::new()];
    for (section, title) in [
        ("user", "About the user"),
        ("agent", "About the agent"),
        ("shared", "Shared history"),
    ] {
        let selected = kept
            .iter()
            .copied()
            .filter(|&i| normalize_section(entries[i].section.as_text_ref(), aliases) == section)
            .collect::<Vec<_>>();
        if selected.is_empty() {
            continue;
        }
        lines.push(points(&format!("## {title}")));
        for index in selected {
            lines.push(line(&entries[index])?);
        }
        lines.push(Vec::new());
    }
    let mut output = Vec::new();
    for (index, line) in lines.into_iter().enumerate() {
        if index > 0 {
            output.push(10);
        }
        output.extend(line);
    }
    let mut output = PythonTextRef::from_codepoints(&output)
        .expect("checked fields and ASCII framing")
        .trimmed()
        .codepoints()
        .into_owned();
    output.push(10);
    Ok(PythonText::try_new(output).expect("checked profile output"))
}
fn points(value: &str) -> Vec<u32> {
    value.chars().map(u32::from).collect()
}
fn line(entry: &ProfileEntry) -> Result<Vec<u32>, ProfileRenderError> {
    if !entry.importance.is_finite() {
        return Err(ProfileRenderError::Number);
    }
    let rounded = entry.importance.round_ties_even();
    let number = if rounded == 0.0 {
        "0".to_owned()
    } else {
        format!("{rounded:.0}")
    };
    let mut result = points(&format!("- ({number}) "));
    result.extend_from_slice(&entry.text.as_text_ref().trimmed().codepoints());
    Ok(result)
}
