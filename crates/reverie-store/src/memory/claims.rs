use super::*;
use reverie_core::memory::normalize_utterance_text;
use rusqlite::{OptionalExtension, params};
impl MemoryTransaction<'_> {
    pub fn get_state(&self, key: &str, default: Option<&str>) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row("SELECT value FROM state WHERE key=?", [key], |row| {
                row.get(0)
            })
            .optional()?
            .or_else(|| default.map(str::to_owned)))
    }
    pub fn set_state(&mut self, key: &str, value: &str) -> Result<()> {
        self.begin_write()?;
        self.db.execute(
            "INSERT OR REPLACE INTO state(key, value) VALUES (?, ?)",
            params![key, value],
        )?;
        self.commit_if_outer()
    }
    pub fn claim_message(&mut self, source_id: &str, at: Option<f64>) -> Result<bool> {
        if source_id.is_empty() {
            return Ok(true);
        }
        let at = at.unwrap_or_else(now);
        self.begin_write()?;
        let claimed = self.db.execute(
            "INSERT OR IGNORE INTO answered(source_id, at) VALUES (?, ?)",
            params![source_id, at],
        )? == 1;
        if claimed {
            self.db
                .execute("DELETE FROM answered WHERE at < ?", [at - 7.0 * 86400.0])?;
        }
        self.commit()?;
        Ok(claimed)
    }
    pub fn answered(&self, source_id: &str) -> Result<bool> {
        Ok(self
            .db
            .query_row(
                "SELECT 1 FROM answered WHERE source_id=?",
                [source_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }
    pub fn claim_voice(&mut self, text: &str, at: Option<f64>) -> Result<()> {
        self.claim_voice_text(EmbeddingText::from_scalar_text(text), at)
    }
    pub fn claim_voice_text(&mut self, text: EmbeddingText<'_>, at: Option<f64>) -> Result<()> {
        let at = at.unwrap_or_else(now);
        self.begin_write()?;
        self.db
            .execute("DELETE FROM voice_claims WHERE at < ?", [at - 3600.0])?;
        self.db.execute(
            "INSERT INTO voice_claims(norm, at) VALUES (?, ?)",
            params![voice_text(text)?, at],
        )?;
        self.commit()
    }
    pub fn is_voice_claimed(&self, text: &str, within: f64, at: Option<f64>) -> Result<bool> {
        self.is_voice_claimed_text(EmbeddingText::from_scalar_text(text), within, at)
    }
    pub fn is_voice_claimed_text(
        &self,
        text: EmbeddingText<'_>,
        within: f64,
        at: Option<f64>,
    ) -> Result<bool> {
        Ok(self
            .db
            .query_row(
                "SELECT 1 FROM voice_claims WHERE norm=? AND at>=? LIMIT 1",
                params![voice_text(text)?, at.unwrap_or_else(now) - within],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }
}
fn voice_text(text: EmbeddingText<'_>) -> Result<String> {
    normalize_utterance_text(text.as_python_text_ref())
        .codepoints()
        .iter()
        .map(|&cp| char::from_u32(cp))
        .collect::<Option<String>>()
        .ok_or_else(|| EmbeddingError::InvalidText.into())
}
impl MemoryStore {
    pub fn get_state(&self, key: &str, default: Option<&str>) -> Result<Option<String>> {
        self.session(|tx| tx.get_state(key, default))
    }
    pub fn set_state(&self, key: &str, value: &str) -> Result<()> {
        self.session(|tx| tx.set_state(key, value))
    }
    pub fn claim_message(&self, source_id: &str, at: Option<f64>) -> Result<bool> {
        self.session(|tx| tx.claim_message(source_id, at))
    }
    pub fn answered(&self, source_id: &str) -> Result<bool> {
        self.session(|tx| tx.answered(source_id))
    }
    pub fn claim_voice(&self, text: &str, at: Option<f64>) -> Result<()> {
        self.session(|tx| tx.claim_voice(text, at))
    }
    pub fn claim_voice_text(&self, text: EmbeddingText<'_>, at: Option<f64>) -> Result<()> {
        self.session(|tx| tx.claim_voice_text(text, at))
    }
    pub fn is_voice_claimed(&self, text: &str, within: f64, at: Option<f64>) -> Result<bool> {
        self.session(|tx| tx.is_voice_claimed(text, within, at))
    }
    pub fn is_voice_claimed_text(
        &self,
        text: EmbeddingText<'_>,
        within: f64,
        at: Option<f64>,
    ) -> Result<bool> {
        self.session(|tx| tx.is_voice_claimed_text(text, within, at))
    }
}
