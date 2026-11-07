use super::*;
use reverie_core::memory::{self, DREAM, EPISODE, EmbeddingKind, REFLECTION, clamp_importance};
use rusqlite::params;
pub struct EpisodeInput {
    pub user_text: MetadataText,
    pub assistant_text: MetadataText,
    pub importance: f64,
    pub importance_source: MetadataText,
    pub created_at: Option<f64>,
    pub metadata: MemoryMetadata,
}
impl EpisodeInput {
    pub fn new(user_text: &str, assistant_text: &str) -> Self {
        Self::from_text(
            MetadataText::from_scalar_text(user_text),
            MetadataText::from_scalar_text(assistant_text),
        )
    }
    pub fn from_text(user_text: MetadataText, assistant_text: MetadataText) -> Self {
        Self {
            user_text,
            assistant_text,
            importance: 3.0,
            importance_source: MetadataText::from_scalar_text("default"),
            created_at: None,
            metadata: MemoryMetadata::default(),
        }
    }
}
pub struct ReflectionInput {
    pub insight: MetadataText,
    pub importance: f64,
    pub source_ids: MemorySources,
    pub section: MetadataText,
    pub created_at: Option<f64>,
    pub metadata: MemoryMetadata,
}
impl ReflectionInput {
    pub fn new(insight: &str, importance: f64, source_ids: &[i64]) -> Self {
        Self::from_text(
            MetadataText::from_scalar_text(insight),
            importance,
            MemorySources::new(source_ids),
        )
    }
    pub fn from_text(insight: MetadataText, importance: f64, source_ids: MemorySources) -> Self {
        Self {
            insight,
            importance,
            source_ids,
            section: MetadataText::from_scalar_text("shared"),
            created_at: None,
            metadata: MemoryMetadata::default(),
        }
    }
}
pub struct DreamInput {
    pub recall: MetadataText,
    pub tone: MetadataText,
    pub source_ids: MemorySources,
    pub importance: f64,
    pub created_at: Option<f64>,
    pub ideas: Option<MemoryMetadata>,
}
impl DreamInput {
    pub fn new(recall: &str, tone: &str, source_ids: &[i64]) -> Self {
        Self::from_text(
            MetadataText::from_scalar_text(recall),
            MetadataText::from_scalar_text(tone),
            MemorySources::new(source_ids),
        )
    }
    pub fn from_text(recall: MetadataText, tone: MetadataText, source_ids: MemorySources) -> Self {
        Self {
            recall,
            tone,
            source_ids,
            importance: 2.0,
            created_at: None,
            ideas: None,
        }
    }
}
struct Insertion {
    kind: &'static str,
    text: MetadataText,
    importance: f64,
    source: MetadataText,
    created_at: Option<f64>,
    user: MetadataText,
    assistant: MetadataText,
    sources: MemorySources,
    section: MetadataText,
    metadata: MemoryMetadata,
    external: Option<MetadataText>,
}
struct PreparedInsertion {
    input: Insertion,
    created_at: f64,
    packed: Vec<u8>,
    model: MetadataText,
}
fn as_text(input: &MetadataText) -> EmbeddingText<'_> {
    EmbeddingText::from_python_text_ref(input.as_python_text_ref())
}
fn sql_text(input: &MetadataText) -> Result<String> {
    input
        .scalar_text()
        .ok_or_else(|| EmbeddingError::InvalidText.into())
}
fn episode_content(user: &MetadataText, assistant: &MetadataText) -> MetadataText {
    let text = memory::episode_text_codepoints(as_text(user), as_text(assistant));
    embedding_text(EmbeddingText::from_codepoints(&text).expect("valid episode text"))
}
fn episode(input: EpisodeInput) -> Insertion {
    Insertion {
        kind: EPISODE,
        text: episode_content(&input.user_text, &input.assistant_text),
        importance: input.importance,
        source: input.importance_source,
        created_at: input.created_at,
        user: input.user_text,
        assistant: input.assistant_text,
        sources: MemorySources::new(&[]),
        section: MetadataText::from_scalar_text(""),
        metadata: input.metadata,
        external: None,
    }
}
fn reflection(input: ReflectionInput) -> Result<Insertion> {
    Ok(Insertion {
        kind: REFLECTION,
        text: embedding_text(as_text(&input.insight).trimmed()),
        importance: input.importance,
        source: MetadataText::from_scalar_text("model"),
        created_at: input.created_at,
        user: MetadataText::from_scalar_text(""),
        assistant: MetadataText::from_scalar_text(""),
        sources: input.source_ids.iterated()?,
        section: input.section,
        metadata: input.metadata,
        external: None,
    })
}
fn external(
    source: MetadataText,
    user: MetadataText,
    assistant: MetadataText,
    visibility: MetadataText,
) -> Result<Insertion> {
    if source.codepoints().is_empty() {
        return Err(MemoryError::EmptyExternalSource);
    }
    let metadata = MemoryMetadata::external_episode_text(&source, &visibility);
    Ok(Insertion {
        kind: EPISODE,
        text: episode_content(&user, &assistant),
        importance: 3.0,
        source: MetadataText::from_scalar_text("default"),
        created_at: None,
        user,
        assistant,
        sources: MemorySources::new(&[]),
        section: MetadataText::from_scalar_text(""),
        metadata,
        external: Some(source),
    })
}
fn dream(input: DreamInput) -> Result<Insertion> {
    Ok(Insertion {
        kind: DREAM,
        text: embedding_text(as_text(&input.recall).trimmed().take(240)),
        importance: input.importance,
        source: MetadataText::from_scalar_text("fixed"),
        created_at: input.created_at,
        user: MetadataText::from_scalar_text(""),
        assistant: MetadataText::from_scalar_text(""),
        sources: input.source_ids.iterated()?,
        section: MetadataText::from_scalar_text(""),
        metadata: MemoryMetadata::dream_text(&input.recall, &input.tone, input.ideas.as_ref()),
        external: None,
    })
}
fn prepare(input: Insertion, embedder: &dyn Embedder) -> Result<PreparedInsertion> {
    let created_at = input.created_at.unwrap_or_else(now);
    let vector = embedder.embed_text(as_text(&input.text), EmbeddingKind::Document)?;
    Ok(PreparedInsertion {
        input,
        created_at,
        packed: memory::pack(&vector),
        model: embedding_text(embedder.name()),
    })
}
impl MemoryTransaction<'_> {
    pub fn add_episode(&mut self, input: EpisodeInput) -> Result<Memory> {
        self.insert(episode(input))
    }
    pub fn add_reflection(&mut self, input: ReflectionInput) -> Result<Memory> {
        self.insert(reflection(input)?)
    }
    pub fn add_dream(&mut self, input: DreamInput) -> Result<Memory> {
        self.insert(dream(input)?)
    }
    pub fn add_external_episode(
        &mut self,
        source: &str,
        user: &str,
        assistant: &str,
        visibility: &str,
    ) -> Result<Memory> {
        self.add_external_episode_text(
            MetadataText::from_scalar_text(source),
            MetadataText::from_scalar_text(user),
            MetadataText::from_scalar_text(assistant),
            MetadataText::from_scalar_text(visibility),
        )
    }
    pub fn add_external_episode_text(
        &mut self,
        source: MetadataText,
        user: MetadataText,
        assistant: MetadataText,
        visibility: MetadataText,
    ) -> Result<Memory> {
        self.insert(external(source, user, assistant, visibility)?)
    }
    fn insert(&mut self, input: Insertion) -> Result<Memory> {
        self.install(prepare(input, self.embedder)?)
    }
    fn install(&mut self, prepared: PreparedInsertion) -> Result<Memory> {
        let PreparedInsertion {
            input,
            created_at,
            packed,
            model,
        } = prepared;
        self.own_transaction(|this| {
            this.begin_write()?;if let Some(memory)=this.claim_external(input.external.as_ref())?{return Ok(memory);}
            // All Python text remains lossless until these actual UTF8 SQL
            // bindings, after embedding and external-source claim ordering.
            this.db.execute("INSERT INTO memories(kind, created_at, user_text, assistant_text, text, importance, importance_source, embed_model, embedding, source_ids, section, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",params![input.kind,created_at,sql_text(&input.user)?,sql_text(&input.assistant)?,sql_text(&input.text)?,clamp_importance(input.importance),sql_text(&input.source)?,sql_text(&model)?,packed,input.sources.json(),sql_text(&input.section)?,input.metadata.or_empty().json()])?;
            let id=this.db.last_insert_rowid();if let Some(source)=input.external {this.db.execute("UPDATE external_episodes SET memory_id=? WHERE source_id=?",params![id,sql_text(&source)?])?;}this.get(id)
        })
    }
    fn claim_external(&self, source: Option<&MetadataText>) -> Result<Option<Memory>> {
        let Some(source) = source else {
            return Ok(None);
        };
        let source = sql_text(source)?;
        if self.db.execute(
            "INSERT OR IGNORE INTO external_episodes(source_id) VALUES (?)",
            [&source],
        )? != 0
        {
            return Ok(None);
        }
        let id = self.db.query_row(
            "SELECT memory_id FROM external_episodes WHERE source_id=?",
            [&source],
            |row| row.get::<_, Option<i64>>(0),
        )?;
        self.get(id.ok_or(MemoryError::MissingExternalMemory)?)
            .map(Some)
    }
    pub fn set_importance(&mut self, id: i64, importance: f64, source: &str) -> Result<()> {
        self.begin_write()?;
        self.db.execute(
            "UPDATE memories SET importance=?, importance_source=? WHERE id=?",
            params![clamp_importance(importance), source, id],
        )?;
        self.commit()
    }
    pub fn touch(&mut self, ids: &[i64], at: Option<f64>) -> Result<()> {
        let at = at.unwrap_or_else(now);
        for &id in ids {
            self.begin_write()?;
            self.db.execute(
                "UPDATE memories SET last_accessed=? WHERE id=?",
                params![at, id],
            )?;
        }
        self.commit()
    }
    pub fn reembed_all(&mut self) -> Result<usize> {
        let model = self
            .embedder
            .name()
            .scalar_text()
            .ok_or(EmbeddingError::InvalidText)?
            .into_owned();
        let rows = {
            let mut statement = self
                .db
                .prepare("SELECT id, text FROM memories WHERE embed_model != ?")?;
            statement
                .query_map([&model], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (id, text) in &rows {
            let packed = memory::pack(&self.embedder.embed(text, EmbeddingKind::Document)?);
            self.begin_write()?;
            self.db.execute(
                "UPDATE memories SET embedding=?, embed_model=? WHERE id=?",
                params![packed, model, id],
            )?;
        }
        self.commit()?;
        Ok(rows.len())
    }
    pub fn release_dream(&mut self, id: i64, released: bool) -> Result<()> {
        let memory = self.get(id)?;
        if memory.kind != DREAM {
            return Err(MemoryError::NotDream(id));
        }
        let metadata = memory.meta.with_released(released)?;
        self.begin_write()?;
        self.db.execute(
            "UPDATE memories SET meta=? WHERE id=?",
            params![metadata.json(), id],
        )?;
        self.commit()
    }
    pub fn prune_dream_summaries(&mut self, keep: i64) -> Result<usize> {
        let result = (|| {
            self.begin_write()?;
            Ok(self.db.execute("DELETE FROM memories WHERE kind=? AND id NOT IN (SELECT id FROM memories WHERE kind=? ORDER BY created_at DESC,id DESC LIMIT ?)",params![DREAM,DREAM,keep.max(1)])?)
        })();
        match result {
            Ok(count) => match self.commit() {
                Ok(()) => Ok(count),
                Err(error) => finalized(Err(error), self.rollback()),
            },
            Err(error) => finalized(Err(error), self.rollback()),
        }
    }
}
impl MemoryStore {
    fn insert_without_lock(&self, input: Insertion) -> Result<Memory> {
        let embedder = self.current_embedder()?;
        let prepared = prepare(input, embedder.as_ref())?;
        self.session(|tx| tx.install(prepared))
    }
    pub fn add_episode(&self, input: EpisodeInput) -> Result<Memory> {
        self.insert_without_lock(episode(input))
    }
    pub fn add_reflection(&self, input: ReflectionInput) -> Result<Memory> {
        self.insert_without_lock(reflection(input)?)
    }
    pub fn add_external_episode(
        &self,
        source: &str,
        user: &str,
        assistant: &str,
        visibility: &str,
    ) -> Result<Memory> {
        self.add_external_episode_text(
            MetadataText::from_scalar_text(source),
            MetadataText::from_scalar_text(user),
            MetadataText::from_scalar_text(assistant),
            MetadataText::from_scalar_text(visibility),
        )
    }
    pub fn add_external_episode_text(
        &self,
        source: MetadataText,
        user: MetadataText,
        assistant: MetadataText,
        visibility: MetadataText,
    ) -> Result<Memory> {
        self.insert_without_lock(external(source, user, assistant, visibility)?)
    }
    pub fn add_dream(&self, input: DreamInput) -> Result<Memory> {
        self.insert_without_lock(dream(input)?)
    }
    pub fn set_importance(&self, id: i64, importance: f64, source: &str) -> Result<()> {
        self.session(|tx| tx.set_importance(id, importance, source))
    }
    pub fn touch(&self, ids: &[i64], at: Option<f64>) -> Result<()> {
        self.session(|tx| tx.touch(ids, at))
    }
    pub fn reembed_all(&self) -> Result<usize> {
        self.session(|tx| tx.reembed_all())
    }
    pub fn release_dream(&self, id: i64, released: bool) -> Result<()> {
        self.session(|tx| tx.release_dream(id, released))
    }
    pub fn prune_dream_summaries(&self, keep: i64) -> Result<usize> {
        self.session(|tx| tx.prune_dream_summaries(keep))
    }
}
