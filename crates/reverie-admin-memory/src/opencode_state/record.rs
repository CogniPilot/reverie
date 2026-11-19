use super::Result;
use reverie_application::memory_startup::StartedMemory;
use reverie_contracts::storage_identity::MetadataText;
use reverie_core::memory::trim_text;
use reverie_host::{memory_configuration::MemoryConfiguration, memory_screen::MemoryScreen};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
pub(super) struct Request {
    source_id: String,
    user: String,
    reply: String,
    visibility: Option<String>,
}

impl Request {
    pub(super) fn save(self, configuration: &MemoryConfiguration) -> Result<Value> {
        self.validate()?;
        let memory = StartedMemory::initialize(configuration, &[])?;
        let result = self.record(memory.store());
        let closed = memory.close();
        let id = result?;
        closed?;
        Ok(json!({ "memory_id": id }))
    }

    fn validate(&self) -> Result<()> {
        if trim_text(&self.user).is_empty() || trim_text(&self.reply).is_empty() {
            return Err("a completed turn requires input and reply".into());
        }
        if self.source_id.is_empty() {
            return Err("an external episode needs a source id".into());
        }
        let screen = MemoryScreen::capture_current()?;
        if !screen
            .check(&MetadataText::from_scalar_text(&self.reply))?
            .is_empty()
        {
            return Err("reply crossed a hard floor".into());
        }
        Ok(())
    }

    fn record(&self, store: &reverie_store::memory::MemoryStore) -> Result<i64> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
        let episode = store.add_external_episode(
            &self.source_id,
            &self.user,
            &self.reply,
            self.visibility.as_deref().unwrap_or("private"),
        )?;
        store.set_state("reverie_last_activity", &now.to_string())?;
        Ok(episode.id)
    }
}
