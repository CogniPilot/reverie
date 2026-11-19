use super::{Report, Result, policy::Policy, rooms::Rooms};
use crate::opencode_state::maintenance;
use jiff::{Timestamp, tz::TimeZone};
use reverie_application::memory_startup::StartedMemory;
use reverie_contracts::storage_identity::MetadataText;
use reverie_core::memory_configuration::TextSetting;
use reverie_host::{
    memory_configuration::{MemoryConfiguration, MemoryPath},
    memory_screen::MemoryScreen,
};
use reverie_store::memory::MemoryStore;
use std::{io::Write, net::IpAddr};

const EPISODES_PER_PASS: usize = 200;
const CURSOR: &str = "sleep_consolidated_ms";
const ACTIVITY: &str = "reverie_last_activity";

pub(super) fn local_models(config: &MemoryConfiguration) -> bool {
    [TextSetting::ApiBase, TextSetting::EmbedUrl]
        .into_iter()
        .all(|key| {
            config
                .settings()
                .text(key)
                .as_text_ref()
                .scalar_text()
                .is_some_and(|value| local_endpoint(&value))
        })
}

fn local_endpoint(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let Ok(uri) = value.parse::<http::Uri>() else {
        return false;
    };
    let Some(authority) = uri.authority() else {
        return false;
    };
    if !matches!(uri.scheme_str(), Some("http" | "https")) || authority.as_str().contains('@') {
        return false;
    }
    let host = authority
        .host()
        .trim_start_matches('[')
        .trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || match host.parse::<IpAddr>() {
            Ok(IpAddr::V4(address)) => address.is_loopback() || address.is_link_local(),
            Ok(IpAddr::V6(address)) => address.is_loopback() || address.is_unicast_link_local(),
            Err(_) => false,
        }
}

pub(super) fn with_store<T>(
    config: &MemoryConfiguration,
    dry_run: bool,
    run: impl FnOnce(&MemoryStore) -> Result<T>,
) -> Result<T> {
    if dry_run {
        let path = config.native_path(MemoryPath::Database)?;
        let store = if path.try_exists()? {
            MemoryStore::open(path)?
        } else {
            MemoryStore::open(":memory:")?
        };
        let result = run(&store);
        let close = store.close();
        let result = result?;
        close?;
        Ok(result)
    } else {
        let memory = StartedMemory::initialize(config, &[])?;
        let result = run(memory.store());
        let close = memory.close();
        let result = result?;
        close?;
        Ok(result)
    }
}

pub(super) fn consolidate(
    policy: &Policy,
    report: &mut Report,
    agent: &str,
    rooms: &Rooms<'_>,
    ids: &std::collections::BTreeSet<String>,
    store: &MemoryStore,
    now: f64,
) -> Result<()> {
    let mark = store
        .get_state(CURSOR, None)?
        .map_or(Ok(0.0), |value| value.parse::<f64>())?;
    if !mark.is_finite() {
        return Err("invalid sleep consolidation cursor".into());
    }
    let since = policy.backfill_days.map_or(mark, |days| {
        mark.max((now - f64::from(days) * 86_400.0) * 1000.0)
    });
    let screen = MemoryScreen::capture_current()?;
    let episodes = rooms.episodes(ids, since, &screen)?;
    let end = if policy.dry_run {
        episodes.len()
    } else {
        chunk_end(&episodes)
    };
    let mut kept = 0;
    for chunk in episodes[..end].chunks(256) {
        let replies: Vec<_> = chunk
            .iter()
            .map(|episode| MetadataText::from_scalar_text(&episode.reply))
            .collect();
        let verdicts = screen.check_many(&replies)?;
        for (episode, reason) in chunk.iter().zip(verdicts) {
            if !reason.is_empty() {
                continue;
            }
            if !policy.dry_run {
                store.add_external_episode(
                    &episode.source,
                    &episode.user,
                    &episode.reply,
                    "private",
                )?;
            }
            kept += 1;
        }
    }
    if !policy.dry_run
        && let Some(last) = episodes[..end].last()
    {
        advance(store, last.at)?;
    }
    report.line(
        if policy.dry_run {
            "would_consolidate"
        } else {
            "consolidated"
        },
        agent,
        kept,
    )
}

fn chunk_end(episodes: &[super::rooms::Episode]) -> usize {
    let Some(boundary) = episodes.get(EPISODES_PER_PASS - 1) else {
        return episodes.len();
    };
    episodes.partition_point(|item| item.at <= boundary.at)
}

fn advance(store: &MemoryStore, timestamp: f64) -> Result<()> {
    store.atomic_immediate(|tx| {
        let current = tx
            .get_state(CURSOR, None)?
            .and_then(|value| value.parse::<f64>().ok());
        if current.is_none_or(|current| current < timestamp) {
            tx.set_state(CURSOR, &timestamp.to_string())?;
        }
        let seconds = timestamp / 1000.0;
        let activity = tx
            .get_state(ACTIVITY, None)?
            .and_then(|value| value.parse::<f64>().ok());
        if activity.is_none_or(|activity| activity < seconds) {
            tx.set_state(ACTIVITY, &seconds.to_string())?;
        }
        Ok(())
    })?;
    Ok(())
}

pub(super) fn preview(
    config: &MemoryConfiguration,
    store: &MemoryStore,
    now: f64,
) -> Result<&'static str> {
    Ok(match maintenance::due(config, store, now)? {
        (true, true) => "would_reflect_dream",
        (true, false) => "would_reflect",
        (false, true) => "would_dream",
        (false, false) => "nothing_due",
    })
}

pub(super) fn morning_note(config: &MemoryConfiguration, store: &MemoryStore) -> Result<usize> {
    let mut lines = Vec::new();
    if let Some(dream) = store.latest_dream()? {
        let date = Timestamp::from_microsecond((dream.created_at * 1_000_000.0) as i64)?
            .to_zoned(TimeZone::UTC);
        let recall = dream
            .recall()?
            .scalar_text()
            .ok_or("invalid dream recall text")?;
        lines.push(format!("Dream ({}): {recall}", date.strftime("%Y-%m-%d")));
    }
    let mut insights = store.reflections()?;
    insights.sort_by(|left, right| left.created_at.total_cmp(&right.created_at));
    if !insights.is_empty() {
        lines.push("Insights:".to_owned());
        lines.extend(
            insights
                .iter()
                .rev()
                .take(3)
                .map(|row| format!("- {}", row.text)),
        );
    }
    let note = clip(&lines.join("\n"), 600);
    let path = config
        .native_path(MemoryPath::Data)?
        .join("morning-note.md");
    super::storage::replace(&path, 0o644, |file| {
        writeln!(file, "{note}")?;
        Ok(())
    })?;
    Ok(note.chars().count())
}

pub(super) fn clip(text: &str, limit: usize) -> String {
    let chars: Vec<_> = text.chars().collect();
    if chars.len() <= limit {
        return text.to_owned();
    }
    let cut = &chars[..limit];
    if matches!(cut[limit - 1], '.' | '!' | '?') && matches!(chars[limit], ' ' | '\n') {
        return cut.iter().collect();
    }
    let punctuation = cut
        .windows(2)
        .rposition(|pair| matches!(pair, ['.' | '!' | '?', ' ']));
    let line = cut.iter().rposition(|&c| c == '\n');
    if let Some(end) = punctuation.max(line).filter(|&end| end >= limit / 2) {
        return cut[..=end].iter().collect::<String>().trim_end().to_owned();
    }
    let end = cut[..limit - 1]
        .iter()
        .rposition(|&c| c == ' ')
        .filter(|&index| index > 0)
        .unwrap_or(limit - 1);
    format!("{}…", cut[..end].iter().collect::<String>().trim_end())
}
