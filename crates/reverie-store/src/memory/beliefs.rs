use super::*;
use reverie_core::memory::{clamp_importance, collapse_whitespace};
use rusqlite::{OptionalExtension, params};
fn belief(row: &rusqlite::Row<'_>) -> rusqlite::Result<Belief> {
    Ok(Belief {
        id: row.get("id")?,
        text: row.get("text")?,
        weight: row.get("weight")?,
        parent_id: row.get("parent_id")?,
        protected: row.get::<_, i64>("protected")? != 0,
        created_at: row.get("created_at")?,
    })
}
impl MemoryTransaction<'_> {
    pub fn beliefs(&self) -> Result<Vec<Belief>> {
        let mut statement = self
            .db
            .prepare("SELECT * FROM beliefs ORDER BY weight DESC, id")?;
        Ok(statement
            .query_map([], belief)?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub fn add_belief(
        &mut self,
        text: &str,
        weight: f64,
        parent: Option<i64>,
        protected: bool,
        created_at: Option<f64>,
    ) -> Result<Belief> {
        let created_at = created_at.unwrap_or_else(now);
        let text = collapse_whitespace(text);
        if text.is_empty() {
            return Err(MemoryError::EmptyBelief);
        }
        if let Some(parent) = parent
            && self
                .db
                .query_row("SELECT 1 FROM beliefs WHERE id=?", [parent], |_| Ok(()))
                .optional()?
                .is_none()
        {
            return Err(MemoryError::Missing(parent));
        }
        self.begin_write()?;
        self.db.execute("INSERT INTO beliefs(text, weight, parent_id, protected, created_at) VALUES (?,?,?,?,?)",params![text,clamp_importance(weight),parent,i64::from(protected),created_at])?;
        self.commit_if_outer()?;
        Ok(self.db.query_row(
            "SELECT * FROM beliefs WHERE id=?",
            [self.db.last_insert_rowid()],
            belief,
        )?)
    }
    pub fn remove_belief(&mut self, id: i64) -> Result<()> {
        let protected = self
            .db
            .query_row("SELECT protected FROM beliefs WHERE id=?", [id], |row| {
                row.get::<_, i64>(0)
            })
            .optional()?
            .ok_or(MemoryError::Missing(id))?;
        if protected != 0 {
            return Err(MemoryError::ProtectedBelief(id));
        }
        self.begin_write()?;
        self.db.execute(
            "DELETE FROM beliefs WHERE id=? OR parent_id=?",
            params![id, id],
        )?;
        self.commit()
    }
}
impl MemoryStore {
    pub fn beliefs(&self) -> Result<Vec<Belief>> {
        self.session(|tx| tx.beliefs())
    }
    pub fn add_belief(
        &self,
        text: &str,
        weight: f64,
        parent: Option<i64>,
        protected: bool,
        created_at: Option<f64>,
    ) -> Result<Belief> {
        self.session(|tx| tx.add_belief(text, weight, parent, protected, created_at))
    }
    pub fn remove_belief(&self, id: i64) -> Result<()> {
        self.session(|tx| tx.remove_belief(id))
    }
}
