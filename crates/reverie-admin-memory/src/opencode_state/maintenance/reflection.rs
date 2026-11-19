pub(crate) mod insight;

use super::{Result, integer, model, state};
use crate::context_cli::render_beliefs;
use insight::Insight;
use reverie_application::memory_startup::refresh_memory_profile;
use reverie_contracts::memory::MemoryMetadata;
use reverie_core::memory::Belief;
use reverie_core::memory_configuration::IntegerSetting;
use reverie_host::memory_configuration::MemoryConfiguration;
use reverie_store::memory::{Memory, MemoryStore, MemoryTransaction, ReflectionInput};
use serde_json::json;

const CURSOR: &str = "last_reflected_id";
const LAST: &str = "last_reflection_at";
const OWNER: &str = "owner";
const CLAIMED: &str = "claimed";

pub(super) struct Batch {
    episodes: Vec<Memory>,
    since: f64,
}

impl Batch {
    pub(super) fn due(
        config: &MemoryConfiguration,
        store: &MemoryStore,
        now: f64,
    ) -> Result<Option<Self>> {
        let since = state(store, LAST, 0.0)?;
        if now - since < integer(config, IntegerSetting::ReflectInterval)? as f64 {
            return Ok(None);
        }
        let mut episodes = Vec::new();
        for episode in store.episodes_after(state(store, CURSOR, 0)?, 40)? {
            if !episode.is_idle()? {
                episodes.push(episode);
            }
        }
        let due = episodes.len() as i64 >= integer(config, IntegerSetting::ReflectMinEpisodes)?;
        Ok(due.then_some(Self { episodes, since }))
    }

    pub(super) fn run(
        self,
        config: &MemoryConfiguration,
        store: &MemoryStore,
        now: f64,
    ) -> Result<usize> {
        store.set_state(LAST, &now.to_string())?;
        let Some(last) = self.episodes.iter().map(|m| m.id).max() else {
            return Ok(0);
        };
        let revisable = store.get_state("revisable_self_model", None)?.as_deref() == Some("1");
        let Some(insights) = self.infer(config, store, revisable)? else {
            return Ok(0);
        };
        let beliefs = store.beliefs()?;
        let root = beliefs
            .iter()
            .filter(|item| item.protected && item.parent_id.is_none())
            .reduce(|first, next| {
                if next.weight > first.weight {
                    next
                } else {
                    first
                }
            });
        let count = store.atomic(|tx| {
            let mut count = 0;
            for (insight, trust) in insights {
                count += install(tx, insight, trust, root, revisable, now)?;
            }
            tx.set_state(CURSOR, &last.to_string())?;
            Ok(count)
        })?;
        refresh_memory_profile(store, config)?;
        Ok(count)
    }

    fn infer(
        &self,
        config: &MemoryConfiguration,
        store: &MemoryStore,
        revisable: bool,
    ) -> Result<Option<Vec<(Insight, &'static str)>>> {
        let beliefs = store.beliefs()?;
        let all: Vec<_> = self.episodes.iter().collect();
        let trusted: Vec<_> = all
            .iter()
            .copied()
            .filter(|m| m.meta.is_owner_observation())
            .collect();
        let mut out = Vec::new();
        if !trusted.is_empty() {
            let protected: Vec<_> = beliefs
                .iter()
                .filter(|item| item.protected)
                .cloned()
                .collect();
            let Some(reply) = ask(
                config,
                &trusted,
                &belief_block(&protected, revisable),
                revisable,
            )?
            else {
                return Ok(None);
            };
            out.extend(
                reply
                    .into_iter()
                    .filter(|i| !i.sources.is_empty())
                    .map(|i| (i, OWNER)),
            );
        }
        if all.len() != trusted.len() {
            let context = belief_block(&beliefs, revisable) + &dream_block(store, self.since)?;
            let Some(reply) = ask(config, &all, &context, revisable)? else {
                return Ok(None);
            };
            out.extend(
                reply
                    .into_iter()
                    .filter(|i| i.section != "belief")
                    .map(|mut i| {
                        i.importance = i.importance.min(4.0);
                        i.section = "shared";
                        (i, CLAIMED)
                    }),
            );
        }
        Ok(Some(out))
    }
}

fn ask(
    config: &MemoryConfiguration,
    rows: &[&Memory],
    extra: &str,
    revisable: bool,
) -> Result<Option<Vec<Insight>>> {
    let exchanges = rows
        .iter()
        .map(|row| format!("[{}] {}", row.id, row.text))
        .collect::<Vec<_>>()
        .join("\n\n");
    let text = format!("Recent exchanges:\n\n{exchanges}{extra}\n\nJSON array of insights:");
    let Some(reply) = model::complete(config, insight::SYSTEM, &text, 600, 0.4, 6000, false) else {
        return Ok(None);
    };
    let ids: Vec<_> = rows.iter().map(|row| row.id).collect();
    Ok(Some(insight::parse(&reply, &ids, revisable)?))
}

fn belief_block(beliefs: &[Belief], revisable: bool) -> String {
    if beliefs.is_empty() {
        return String::new();
    }
    let label = if revisable {
        "Your current self-understanding (revisable through deliberate self-model changes):"
    } else {
        "Your held beliefs about yourself (stable, not for re-evaluation):"
    };
    format!("\n\n{label}\n{}", render_beliefs(beliefs))
}

fn dream_block(store: &MemoryStore, since: f64) -> Result<String> {
    let dreams = store.dreams_since(since)?;
    if dreams.is_empty() {
        return Ok(String::new());
    }
    let lines = dreams
        .iter()
        .skip(dreams.len().saturating_sub(3))
        .map(|item| {
            let recall = item.recall()?.scalar_text().ok_or("invalid dream recall")?;
            Ok(format!("- {recall}"))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(format!(
        "\n\nRecent dreams (not events, low weight):\n{}",
        lines.join("\n")
    ))
}

fn install(
    tx: &mut MemoryTransaction<'_>,
    insight: Insight,
    trust: &str,
    root: Option<&Belief>,
    revisable: bool,
    now: f64,
) -> reverie_store::memory::Result<usize> {
    let belief = insight.section == "belief";
    if belief {
        if let Some(root) = root {
            tx.add_belief(
                &insight.insight,
                insight.importance.min(root.weight),
                Some(root.id),
                false,
                Some(now),
            )?;
            return Ok(0);
        }
        if !revisable {
            return Ok(0);
        }
    }
    let (section, metadata) = if belief {
        ("agent", json!({"self_observation":true, "trust":trust}))
    } else {
        (insight.section, json!({"trust":trust}))
    };
    let mut input = ReflectionInput::new(&insight.insight, insight.importance, &insight.sources);
    input.section = reverie_contracts::storage_identity::MetadataText::from_scalar_text(section);
    input.created_at = Some(now);
    input.metadata = MemoryMetadata::decode(&metadata.to_string())?;
    tx.add_reflection(input)?;
    Ok(1)
}
