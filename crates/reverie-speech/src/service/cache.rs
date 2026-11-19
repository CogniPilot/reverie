use crate::{Result, piper::AUDIO_LIMIT, process};
use bytes::Bytes;
use std::{
    collections::VecDeque,
    io,
    path::PathBuf,
    time::{Duration, Instant, SystemTime},
};

pub(super) struct Cache {
    ttl: Duration,
    old: PathBuf,
    recent: VecDeque<Entry>,
}

struct Entry {
    id: String,
    created: Instant,
    bytes: Bytes,
}

impl Cache {
    pub(super) fn new(ttl: Duration, old: PathBuf) -> Self {
        Self {
            ttl,
            old,
            recent: VecDeque::new(),
        }
    }

    pub(super) fn put(&mut self, bytes: Bytes) -> Result<String> {
        self.prune();
        let mut random = [0u8; 16];
        getrandom::getrandom(&mut random).map_err(|error| io::Error::other(error.to_string()))?;
        let id: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        if self.recent.len() == 8 {
            self.recent.pop_front();
        }
        self.recent.push_back(Entry {
            id: id.clone(),
            created: Instant::now(),
            bytes,
        });
        Ok(id)
    }

    pub(super) fn get(&mut self, path: &str) -> Option<Bytes> {
        let id = path.strip_suffix(".wav").unwrap_or(path);
        if id.len() != 32
            || !id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return None;
        }
        self.prune();
        self.recent
            .iter()
            .find(|item| item.id == id)
            .map(|item| item.bytes.clone())
            .or_else(|| self.legacy(id))
    }

    fn prune(&mut self) {
        self.recent
            .retain(|entry| entry.created.elapsed() <= self.ttl);
    }

    fn legacy(&self, id: &str) -> Option<Bytes> {
        let file = self.old.join(format!("{id}.wav"));
        let modified = std::fs::symlink_metadata(&file).ok()?.modified().ok()?;
        let age = SystemTime::now().duration_since(modified).ok()?;
        (age <= self.ttl).then_some(())?;
        process::read(&file, AUDIO_LIMIT).ok().map(Bytes::from)
    }
}
