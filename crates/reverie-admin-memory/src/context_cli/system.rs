use super::*;
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
    let mood = mood(data.mood.as_deref(), now);
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

fn render_beliefs(beliefs: &[Belief]) -> String {
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

#[derive(serde::Deserialize)]
struct Mood {
    valence: f64,
    arousal: f64,
    #[serde(default)]
    updated_at: f64,
}

fn mood(raw: Option<&str>, now: f64) -> &'static str {
    let Some(Mood {
        valence,
        arousal,
        updated_at,
    }) = raw.and_then(|text| serde_json::from_str::<Mood>(text).ok())
    else {
        return "content and easy";
    };
    let decay = if updated_at > 0.0 {
        0.5f64.powf((now - updated_at).max(0.0) / 21_600.0)
    } else {
        1.0
    };
    let v = 0.2 + (valence - 0.2) * decay;
    let a = arousal * decay;
    let tones = if v > 0.45 {
        ("bright and happy", "warm and content")
    } else if v > 0.1 {
        ("playful", "content and easy")
    } else if v > -0.1 {
        ("restless", "quiet and even")
    } else if v > -0.45 {
        ("on edge", "a little wistful")
    } else {
        ("anxious", "low and tired")
    };
    if a > 0.2 { tones.0 } else { tones.1 }
}
