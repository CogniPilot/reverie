//! One read-only continuity snapshot. Shared context requests never read
//! episodes, beliefs, mood or dreams.
use super::*;
use reverie_contracts::memory_documents::DocumentBody;
use reverie_core::{
    PythonText,
    memory_documents::{DocumentName, RECENT_EXCHANGE_CAP},
    persona::ProfileEntry,
};
use rusqlite::{OptionalExtension, params};

const EPISODE_FRAME_BYTES: usize = "user: \nassistant: \n\n".len();

#[derive(Clone, Copy)]
pub enum ContinuityScope {
    Shared,
    Private { turns: i64, derive_profile: bool },
}

pub struct Continuity {
    pub self_model: Option<DocumentBody>,
    pub plan: Option<DocumentBody>,
    pub lifecycle: Option<DocumentBody>,
    pub runtime: Option<String>,
    pub private: Option<PrivateContinuity>,
}

#[derive(Default)]
pub struct PrivateContinuity {
    pub revisable: bool,
    pub history_imported: bool,
    pub episodes: Vec<Episode>,
    pub beliefs: Vec<Belief>,
    pub reflections: Vec<ProfileEntry>,
    pub dream: Option<(f64, String, MemoryMetadata)>,
    pub mood: Option<String>,
}

pub struct Episode {
    pub created_at: f64,
    /// A pair larger than the entire render budget is a stopping point.
    pub texts: Option<(String, String)>,
}

impl Continuity {
    pub(super) fn empty(scope: ContinuityScope) -> Self {
        Self {
            self_model: None,
            plan: None,
            lifecycle: None,
            runtime: None,
            private: matches!(scope, ContinuityScope::Private { .. })
                .then(PrivateContinuity::default),
        }
    }
}

pub(super) fn read(db: &Connection, scope: ContinuityScope) -> Result<Continuity> {
    let mut result = Continuity::empty(scope);
    if has_table(db, "reverie_documents")? {
        result.self_model = document(db, "self")?;
        result.plan = document(db, "plan")?;
        result.lifecycle = document(db, "lifecycle")?;
    }
    let has_state = has_table(db, "state")?;
    if has_state && matches!(scope, ContinuityScope::Shared) {
        result.runtime = reader::state(db, "reverie_runtime")?;
    }
    if let ContinuityScope::Private {
        turns,
        derive_profile,
    } = scope
    {
        result.private = Some(private(db, has_state, turns, derive_profile)?);
    }
    Ok(result)
}

fn has_table(db: &Connection, table: &str) -> Result<bool> {
    Ok(db
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE name=? AND type='table'",
            [table],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false))
}

fn document(db: &Connection, name: &str) -> Result<Option<DocumentBody>> {
    let envelope = documents::read_envelope(db, &DocumentName::from_scalar_text(name), None)?;
    Ok((envelope.updated_at.is_some()).then_some(envelope.body))
}

fn private(
    db: &Connection,
    has_state: bool,
    turns: i64,
    derive_profile: bool,
) -> Result<PrivateContinuity> {
    let mut result = PrivateContinuity::default();
    if has_state {
        result.revisable = reader::state(db, "revisable_self_model")?.as_deref() == Some("1");
        result.history_imported =
            reader::state(db, "migrated_legacy_history")?.is_some_and(|value| !value.is_empty());
        result.mood = reader::state(db, "mood")?;
    }
    if has_table(db, "beliefs")? {
        result.beliefs = beliefs::read(db)?;
    }
    if has_table(db, "memories")? {
        result.episodes = episodes(db, turns)?;
        result.dream = dream(db)?;
        if derive_profile {
            result.reflections = reflections(db)?;
        }
    }
    Ok(result)
}

fn episodes(db: &Connection, limit: i64) -> Result<Vec<Episode>> {
    let mut columns = db.prepare("PRAGMA table_info(memories)")?;
    let columns = columns
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let current = columns.iter().any(|name| name == "assistant_text");
    let legacy = columns.iter().any(|name| name == LEGACY_ASSISTANT_COLUMN);
    let assistant = match (current, legacy) {
        (true, false) => "assistant_text",
        (false, true) => LEGACY_ASSISTANT_COLUMN,
        (true, true) => return Err(MemoryError::NeedsMigration),
        (false, false) => return Err(MemoryError::MissingAssistantColumn),
    };
    let mut query = db.prepare(&format!(
        "SELECT created_at, length(CAST(user_text AS BLOB)) + length(CAST({assistant} AS BLOB)), user_text, {assistant} \
         FROM memories WHERE kind='episode' ORDER BY created_at DESC, id DESC LIMIT ?",
    ))?;
    let mut rows = query.query([limit])?;
    let mut result = Vec::new();
    let mut remaining = RECENT_EXCHANGE_CAP;
    while let Some(row) = rows.next()? {
        let bytes = usize::try_from(row.get::<_, i64>(1)?)
            .unwrap_or(usize::MAX)
            .saturating_add(EPISODE_FRAME_BYTES);
        let fits = remaining.checked_sub(bytes);
        result.push(Episode {
            created_at: row.get(0)?,
            texts: fits
                .map(|_| -> rusqlite::Result<_> { Ok((row.get(2)?, row.get(3)?)) })
                .transpose()?,
        });
        let Some(left) = fits else { break };
        remaining = left;
    }
    Ok(result)
}

fn dream(db: &Connection) -> Result<Option<(f64, String, MemoryMetadata)>> {
    let row = db.query_row(
        "SELECT created_at,text,meta FROM memories WHERE kind=? ORDER BY created_at DESC,id DESC LIMIT 1",
        [reverie_core::memory::DREAM],
        |row| Ok((row.get::<_, f64>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?)),
    ).optional()?;
    row.map(|(at, text, meta)| {
        Ok((
            at,
            text,
            MemoryMetadata::decode(meta.as_deref().filter(|s| !s.is_empty()).unwrap_or("{}"))?,
        ))
    })
    .transpose()
}

fn reflections(db: &Connection) -> Result<Vec<ProfileEntry>> {
    let mut query = db.prepare(
        "SELECT id,importance,created_at,text,section FROM memories WHERE kind=? ORDER BY created_at,id",
    )?;
    Ok(query
        .query_map(params![reverie_core::memory::REFLECTION], |row| {
            Ok(ProfileEntry {
                id: row.get(0)?,
                importance: row.get(1)?,
                created_at: row.get(2)?,
                text: PythonText::from_scalar_text(&row.get::<_, String>(3)?),
                section: PythonText::from_scalar_text(&row.get::<_, String>(4)?),
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}
