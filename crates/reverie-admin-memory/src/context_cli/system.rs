use super::*;
use reverie_contracts::memory::decode_mood;
use reverie_core::{
    PythonTextRef,
    memory::{Belief, trim_text},
    persona::{DEFAULT_PERSONA, SectionAliases, render_profile},
};
use reverie_store::memory::PrivateContinuity;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) fn prompt(
    directory: &Path,
    instance: &MemoryInstance,
    model: &DocumentBody,
    profile: Option<String>,
    data: &PrivateContinuity,
    initial: bool,
) -> Result<String> {
    let revisable = data.revisable || (initial && data.beliefs.is_empty());
    let persona = if revisable {
        scalar(&model.text_field("persona")?)?
    } else {
        read_text(&directory.join("persona.txt"))?
            .map(|text| {
                let text = trim_text(&text);
                if text.is_empty() {
                    DEFAULT_PERSONA.to_owned()
                } else {
                    text.to_owned()
                }
            })
            .map_or_else(|| scalar(instance.persona()), Ok)?
    };
    let profile = profile.map_or_else(|| derived_profile(data), Ok)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
    let beliefs = render_beliefs(&data.beliefs);
    let mood = decode_mood(data.mood.as_deref()).decayed(now).describe();
    let dream = recent_dream(data, now)?;
    Ok(system(
        &persona, &profile, &beliefs, revisable, mood, &dream,
    ))
}

fn derived_profile(data: &PrivateContinuity) -> Result<String> {
    let owner = env::var("REVERIE_OWNER_ALIASES").unwrap_or_default();
    let agent = env::var("REVERIE_AGENT_ALIASES").unwrap_or_default();
    let aliases = SectionAliases::from_text(
        PythonTextRef::from_scalar_text(&owner),
        PythonTextRef::from_scalar_text(&agent),
    );
    render_profile(&data.reflections, 2000, &aliases)?
        .as_text_ref()
        .scalar_text()
        .map(|text| text.into_owned())
        .ok_or_else(|| "invalid derived profile text".into())
}

fn system(
    persona: &str,
    profile: &str,
    beliefs: &str,
    revisable: bool,
    mood: &str,
    dream: &str,
) -> String {
    let mut parts = vec![trim_text(persona).to_owned()];
    if !trim_text(beliefs).is_empty() {
        let label = if revisable {
            "Your current self-understanding (your own, revisable with reasons):"
        } else {
            "What you hold to be true about yourself (your own, stable, not up for daily re-evaluation; you may deepen it in your own words):"
        };
        parts.push(format!("{label}\n{}", trim_text(beliefs)));
    }
    if !trim_text(profile).is_empty() {
        parts.push(format!("Your evolving notes about the user and yourself (written by you during quiet moments):\n{}", trim_text(profile)));
    }
    let mut state = format!("Right now you feel {mood}.");
    if !dream.is_empty() {
        state.push_str(" While you slept you had a dream; you may mention it if it fits, unprompted or when asked: ");
        state.push_str(trim_text(dream));
    }
    parts.push(state);
    parts.join("\n\n")
}

pub(crate) fn render_beliefs(beliefs: &[Belief]) -> String {
    let mut ordered = beliefs.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        right
            .weight
            .total_cmp(&left.weight)
            .then(left.created_at.total_cmp(&right.created_at))
    });
    let mut output = Vec::new();
    for root in ordered.iter().filter(|belief| belief.parent_id.is_none()) {
        output.push(format!("- {}", root.text));
        output.extend(
            ordered
                .iter()
                .filter(|belief| belief.parent_id == Some(root.id))
                .map(|belief| format!("  - {}", belief.text)),
        );
    }
    output.join("\n")
}

fn recent_dream(data: &PrivateContinuity, now: f64) -> Result<String> {
    let Some((at, text, meta)) = &data.dream else {
        return Ok(String::new());
    };
    let hours = env_number("REVERIE_DREAM_RECALL_HOURS", 24.0);
    if now - at <= hours * 3600.0 {
        scalar(&meta.waking_recall(text)?)
    } else {
        Ok(String::new())
    }
}
