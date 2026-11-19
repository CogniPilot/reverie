use super::{Result, gpu, integer, model, state};
use crate::{
    context_cli::render_beliefs,
    dream::{parse, prompt, sample, updated_mood},
    opencode_state::documents::body,
};
use reverie_contracts::memory::{DreamReply, MemoryMetadata, decode_mood};
use reverie_core::{
    memory::{EPISODE, trim_text},
    memory_configuration::{FloatSetting, IntegerSetting},
};
use reverie_host::memory_configuration::{MemoryConfiguration, MemoryPath};
use reverie_store::memory::{DreamInput, Memory, MemoryDocuments, MemorySources, MemoryStore};
use serde::Serialize;
use serde_json::{Value, json};
use std::{fs, io, path::Path};

#[derive(Serialize)]
pub(super) struct Prompt {
    pub(super) system: String,
    pub(super) user: String,
    pub(super) max_tokens: u64,
    pub(super) temperature: f64,
    pub(super) max_chars: i64,
}

pub(super) struct Attempt {
    pub(super) prompt: Prompt,
    sources: Vec<i64>,
    mood: Option<String>,
    now: f64,
}

pub(super) fn due(
    config: &MemoryConfiguration,
    store: &MemoryStore,
    now: f64,
    activity: f64,
) -> Result<bool> {
    let limit = integer(config, IntegerSetting::DreamsPerSleep)?;
    Ok(limit > 0
        && now - activity >= integer(config, IntegerSetting::SleepMinIdle)? as f64
        && store.count_dreams_since(activity)? < limit
        && now - state(store, "last_dream_at", 0.0)?
            >= integer(config, IntegerSetting::DreamSpacing)? as f64)
}

pub(super) fn run(
    config: &MemoryConfiguration,
    store: &MemoryStore,
    docs: &MemoryDocuments<'_>,
    now: f64,
    vacation: bool,
) -> Result<Option<Memory>> {
    let Some(guard) = gpu::Gpu::acquire(config, "dream")? else {
        return Ok(None);
    };
    let result = dream(config, store, docs, now, vacation);
    guard.finish()?;
    result
}

fn dream(
    config: &MemoryConfiguration,
    store: &MemoryStore,
    docs: &MemoryDocuments<'_>,
    now: f64,
    vacation: bool,
) -> Result<Option<Memory>> {
    let Some(attempt) = Attempt::prepare(config, store, now, &creative_context(docs)?)? else {
        return Ok(None);
    };
    let prompt = &attempt.prompt;
    let reply = model::complete(
        config,
        &prompt.system,
        &prompt.user,
        prompt.max_tokens,
        prompt.temperature,
        prompt.max_chars,
        vacation,
    );
    let weight = config.settings().float(FloatSetting::DreamMoodWeight);
    attempt.finish(store, reply, weight)
}

impl Attempt {
    pub(super) fn prepare(
        config: &MemoryConfiguration,
        store: &MemoryStore,
        now: f64,
        creative: &str,
    ) -> Result<Option<Self>> {
        let selected = select(&store.all(Some(EPISODE))?, now)?;
        store.set_state("last_dream_at", &now.to_string())?;
        if selected.is_empty() && trim_text(creative).is_empty() {
            return Ok(None);
        }
        let mood = store.get_state("mood", None)?;
        let override_text = read_prompt(&config.native_path(MemoryPath::DreamPrompt)?)?;
        let prompt = Prompt {
            system: prompt::system(override_text.as_deref()),
            user: prompt::user(
                &selected,
                &render_beliefs(&store.beliefs()?),
                store.get_state("revisable_self_model", None)?.as_deref() == Some("1"),
                creative,
                decode_mood(mood.as_deref()).decayed(now).describe(),
            ),
            max_tokens: 800,
            temperature: 1.0,
            max_chars: 6000,
        };
        Ok(Some(Self {
            prompt,
            sources: selected.into_iter().map(|(id, _)| id).collect(),
            mood,
            now,
        }))
    }

    pub(super) fn finish(
        self,
        store: &MemoryStore,
        reply: Option<String>,
        weight: f64,
    ) -> Result<Option<Memory>> {
        let Some(text) = reply else {
            return Ok(None);
        };
        let Some(reply) = parse(text.chars().map(u32::from).collect())? else {
            return Ok(None);
        };
        let mood = updated_mood(reply.tone.as_str(), self.mood.as_deref(), self.now, weight);
        Ok(Some(save(store, &reply, &self.sources, self.now, mood)?))
    }
}

fn select(episodes: &[Memory], now: f64) -> Result<Vec<(i64, String)>> {
    let rows = episodes
        .iter()
        .map(|m| Ok((m.id, m.created_at, m.importance, m.is_idle()?)))
        .collect::<Result<_>>()?;
    let ids = sample(rows, now)?;
    ids.into_iter()
        .map(|id| {
            let selected = episodes
                .iter()
                .find(|m| m.id == id)
                .ok_or("selected dream memory is missing")?;
            Ok((id, selected.text.clone()))
        })
        .collect()
}

fn save(
    store: &MemoryStore,
    reply: &DreamReply,
    sources: &[i64],
    now: f64,
    mood: String,
) -> Result<Memory> {
    let tone =
        reverie_contracts::storage_identity::MetadataText::from_scalar_text(reply.tone.as_str());
    let ideas: Vec<_> = reply.ideas.iter().map(|idea| {
        json!({"hypothesis":idea.hypothesis.scalar_text(), "check":idea.check.scalar_text()})
    }).collect();
    let mut input = DreamInput::from_text(reply.recall.clone(), tone, MemorySources::new(sources));
    input.created_at = Some(now);
    if !ideas.is_empty() {
        input.ideas = Some(MemoryMetadata::decode(&serde_json::to_string(&ideas)?)?);
    }
    let memory = store.atomic(|tx| {
        let memory = tx.add_dream(input)?;
        tx.set_state("mood", &mood)?;
        tx.prune_dream_summaries(30)?;
        Ok(memory)
    })?;
    Ok(memory)
}

fn creative_context(docs: &MemoryDocuments<'_>) -> Result<String> {
    let value = body(&docs.plan()?)?;
    let plan = value.as_str().ok_or("invalid stored plan")?;
    let mut parts = vec![prefix(plan, 4000)];
    for (name, record) in docs.profiles()? {
        let profile = body(&record)?;
        let role = profile["role"]
            .as_str()
            .ok_or("invalid developer profile")?;
        parts.push(format!(
            "{name}: {role}\n{}\n{}",
            profile_notes(&profile, "long_term"),
            profile_notes(&profile, "short_term")
        ));
    }
    Ok(prefix(&parts.join("\n\n"), 8000))
}

fn profile_notes(profile: &Value, key: &str) -> String {
    prefix(profile[key].as_str().unwrap_or_default(), 500)
}

fn prefix(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn read_prompt(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
