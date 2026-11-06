use super::*;
use reverie_core::memory::{self, DREAM, EPISODE, EmbeddingKind, REFLECTION};
use rusqlite::{params, params_from_iter};
pub struct RetrievalOptions<'a> {
    pub k: i64,
    pub now: Option<f64>,
    pub exclude_ids: &'a [i64],
    pub kinds: &'a [&'a str],
    pub weights: [f64; 3],
    pub combine: &'a str,
    pub min_relevance: f64,
}
impl Default for RetrievalOptions<'_> {
    fn default() -> Self {
        Self {
            k: 6,
            now: None,
            exclude_ids: &[],
            kinds: &[EPISODE, REFLECTION, DREAM],
            weights: [1.0, 1.0, 1.0],
            combine: "sum",
            min_relevance: 0.0,
        }
    }
}
struct QueryVector {
    vector: Vec<f64>,
    model: MetadataText,
    now: f64,
}
fn prepare_query(
    query: EmbeddingText<'_>,
    options: &RetrievalOptions<'_>,
    embedder: &dyn Embedder,
) -> Result<QueryVector> {
    let now = options.now.unwrap_or_else(now);
    let vector = embedder.embed_text(query, EmbeddingKind::Query)?;
    Ok(QueryVector {
        vector,
        model: embedding_text(embedder.name()),
        now,
    })
}
fn score(
    candidates: Vec<Memory>,
    query: &QueryVector,
    options: &RetrievalOptions<'_>,
    decay: f64,
) -> Result<Vec<Memory>> {
    let mut scored = Vec::new();
    for mut memory in candidates {
        let relevance = memory::cosine(&query.vector, &memory.embedding);
        if relevance < options.min_relevance {
            continue;
        }
        memory.score = memory::score_memory(
            relevance,
            memory.created_at,
            memory.importance,
            query.now,
            decay,
            options.weights,
            options.combine,
        )?;
        scored.push(memory);
    }
    let ranks = scored
        .iter()
        .map(|memory| memory::MemoryRank {
            score: memory.score,
            created_at: memory.created_at,
        })
        .collect::<Vec<_>>();
    let order = memory::memory_rank_order(&ranks)?;
    let mut slots = scored.into_iter().map(Some).collect::<Vec<_>>();
    let mut scored = order
        .into_iter()
        .map(|index| slots[index].take().expect("rank order is a permutation"))
        .collect::<Vec<_>>();
    let length = if options.k < 0 {
        scored
            .len()
            .saturating_sub(usize::try_from(options.k.unsigned_abs()).unwrap_or(usize::MAX))
    } else {
        usize::try_from(options.k)
            .unwrap_or(usize::MAX)
            .min(scored.len())
    };
    scored.truncate(length);
    Ok(scored)
}
fn memory(row: &rusqlite::Row<'_>) -> Result<Memory> {
    let source_ids = row
        .get::<_, Option<String>>("source_ids")?
        .unwrap_or_default();
    let meta = row.get::<_, Option<String>>("meta")?.unwrap_or_default();
    let blob = row
        .get::<_, Option<Vec<u8>>>("embedding")?
        .unwrap_or_default();
    Ok(Memory {
        id: row.get("id")?,
        kind: row.get("kind")?,
        created_at: row.get("created_at")?,
        user_text: row.get("user_text")?,
        assistant_text: row.get("assistant_text")?,
        text: row.get("text")?,
        importance: row.get("importance")?,
        importance_source: row.get("importance_source")?,
        embed_model: row.get("embed_model")?,
        embedding: memory::unpack(&blob)?,
        source_ids: MemorySources::decode(if source_ids.is_empty() {
            "[]"
        } else {
            &source_ids
        })?,
        section: row.get("section")?,
        meta: MemoryMetadata::decode(if meta.is_empty() { "{}" } else { &meta })?,
        last_accessed: row.get("last_accessed")?,
        score: 0.0,
    })
}
fn memories(mut rows: rusqlite::Rows<'_>) -> Result<Vec<Memory>> {
    let mut output = Vec::new();
    while let Some(row) = rows.next()? {
        output.push(memory(row)?);
    }
    Ok(output)
}
impl MemoryTransaction<'_> {
    pub fn get(&self, id: i64) -> Result<Memory> {
        let mut statement = self.db.prepare("SELECT * FROM memories WHERE id=?")?;
        let mut rows = statement.query([id])?;
        memory(rows.next()?.ok_or(MemoryError::Missing(id))?)
    }
    pub fn count(&self, kind: Option<&str>) -> Result<i64> {
        Ok(if let Some(kind) = kind.filter(|kind| !kind.is_empty()) {
            self.db.query_row(
                "SELECT COUNT(*) FROM memories WHERE kind=?",
                [kind],
                |row| row.get(0),
            )?
        } else {
            self.db
                .query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))?
        })
    }
    pub fn all(&self, kind: Option<&str>) -> Result<Vec<Memory>> {
        if let Some(kind) = kind.filter(|kind| !kind.is_empty()) {
            let mut statement = self
                .db
                .prepare("SELECT * FROM memories WHERE kind=? ORDER BY created_at, id")?;
            memories(statement.query([kind])?)
        } else {
            let mut statement = self
                .db
                .prepare("SELECT * FROM memories ORDER BY created_at, id")?;
            memories(statement.query([])?)
        }
    }
    pub fn recent_episodes(&self, n: i64) -> Result<Vec<Memory>> {
        let mut statement = self.db.prepare(
            "SELECT * FROM memories WHERE kind=? ORDER BY created_at DESC, id DESC LIMIT ?",
        )?;
        let mut values = memories(statement.query(params![EPISODE, n])?)?;
        values.reverse();
        Ok(values)
    }
    pub fn episodes_after(&self, id: i64, limit: i64) -> Result<Vec<Memory>> {
        let mut statement = self
            .db
            .prepare("SELECT * FROM memories WHERE kind=? AND id>? ORDER BY id LIMIT ?")?;
        memories(statement.query(params![EPISODE, id, limit])?)
    }
    pub fn pending_importance(&self, limit: i64) -> Result<Vec<Memory>> {
        let mut statement=self.db.prepare("SELECT * FROM memories WHERE kind=? AND importance_source IN ('default','migrated') ORDER BY id LIMIT ?")?;
        memories(statement.query(params![EPISODE, limit])?)
    }
    pub fn reflections(&self) -> Result<Vec<Memory>> {
        self.all(Some(REFLECTION))
    }
    pub fn dreams_since(&self, since: f64) -> Result<Vec<Memory>> {
        let mut statement = self.db.prepare(
            "SELECT * FROM memories WHERE kind=? AND created_at>? ORDER BY created_at, id",
        )?;
        memories(statement.query(params![DREAM, since])?)
    }
    pub fn count_dreams_since(&self, since: f64) -> Result<i64> {
        Ok(self.db.query_row(
            "SELECT COUNT(*) FROM memories WHERE kind=? AND created_at>?",
            params![DREAM, since],
            |row| row.get(0),
        )?)
    }
    pub fn latest_dream(&self) -> Result<Option<Memory>> {
        let mut statement = self.db.prepare(
            "SELECT * FROM memories WHERE kind=? ORDER BY created_at DESC, id DESC LIMIT 1",
        )?;
        let mut rows = statement.query([DREAM])?;
        rows.next()?.map(memory).transpose()
    }
    pub fn retrieve(&mut self, query: &str, options: RetrievalOptions<'_>) -> Result<Vec<Memory>> {
        self.retrieve_text(EmbeddingText::from_scalar_text(query), options)
    }
    pub fn retrieve_text(
        &mut self,
        query: EmbeddingText<'_>,
        options: RetrievalOptions<'_>,
    ) -> Result<Vec<Memory>> {
        let query = prepare_query(query, &options, self.embedder)?;
        let candidates = self.candidates(&query.model, &options)?;
        let scored = score(candidates, &query, &options, self.decay)?;
        if !scored.is_empty() {
            self.touch(
                &scored.iter().map(|m| m.id).collect::<Vec<_>>(),
                Some(query.now),
            )?;
        }
        Ok(scored)
    }
    fn candidates(
        &self,
        model: &MetadataText,
        options: &RetrievalOptions<'_>,
    ) -> Result<Vec<Memory>> {
        let model = model.scalar_text().ok_or(EmbeddingError::InvalidText)?;
        let placeholders = vec!["?"; options.kinds.len()].join(",");
        let sql =
            format!("SELECT * FROM memories WHERE kind IN ({placeholders}) AND embed_model=?");
        let mut values = options.kinds.to_vec();
        values.push(&model);
        let mut statement = self.db.prepare(&sql)?;
        let mut rows = statement.query(params_from_iter(values))?;
        let mut candidates = Vec::new();
        while let Some(row) = rows.next()? {
            if !options.exclude_ids.contains(&row.get::<_, i64>("id")?) {
                candidates.push(memory(row)?);
            }
        }
        Ok(candidates)
    }
}
impl MemoryStore {
    pub fn get(&self, id: i64) -> Result<Memory> {
        self.session(|tx| tx.get(id))
    }
    pub fn count(&self, kind: Option<&str>) -> Result<i64> {
        self.session(|tx| tx.count(kind))
    }
    pub fn all(&self, kind: Option<&str>) -> Result<Vec<Memory>> {
        self.session(|tx| tx.all(kind))
    }
    pub fn recent_episodes(&self, n: i64) -> Result<Vec<Memory>> {
        self.session(|tx| tx.recent_episodes(n))
    }
    pub fn episodes_after(&self, id: i64, limit: i64) -> Result<Vec<Memory>> {
        self.session(|tx| tx.episodes_after(id, limit))
    }
    pub fn pending_importance(&self, limit: i64) -> Result<Vec<Memory>> {
        self.session(|tx| tx.pending_importance(limit))
    }
    pub fn reflections(&self) -> Result<Vec<Memory>> {
        self.session(|tx| tx.reflections())
    }
    pub fn dreams_since(&self, since: f64) -> Result<Vec<Memory>> {
        self.session(|tx| tx.dreams_since(since))
    }
    pub fn count_dreams_since(&self, since: f64) -> Result<i64> {
        self.session(|tx| tx.count_dreams_since(since))
    }
    pub fn latest_dream(&self) -> Result<Option<Memory>> {
        self.session(|tx| tx.latest_dream())
    }
    pub fn retrieve(&self, query: &str, options: RetrievalOptions<'_>) -> Result<Vec<Memory>> {
        self.retrieve_text(EmbeddingText::from_scalar_text(query), options)
    }
    pub fn retrieve_text(
        &self,
        query: EmbeddingText<'_>,
        options: RetrievalOptions<'_>,
    ) -> Result<Vec<Memory>> {
        let embedder = self.current_embedder()?;
        let query = prepare_query(query, &options, embedder.as_ref())?;
        let candidates = self.session(|tx| tx.candidates(&query.model, &options))?;
        let scored = score(candidates, &query, &options, self.decay_per_hour)?;
        if !scored.is_empty() {
            self.touch(
                &scored.iter().map(|m| m.id).collect::<Vec<_>>(),
                Some(query.now),
            )?;
        }
        Ok(scored)
    }
}
