//! The state directory as `query` reads it: sorted entries, private files,
//! the 5 s read deadline and the post-read custody recheck.
use crate::Refused;
use crate::custody::Owner;
use reverie_contracts::resource_history::{
    FILE_LIMIT, HistoryRequest, HistorySource, ObservationConfig, Tail,
};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// `len(entries) > 1024` refuses the query.
const ENTRY_LIMIT: usize = 1024;

/// One query's custody: the configuration it was read from and its state.
pub struct Store {
    owner: Owner,
    config_path: PathBuf,
    config_raw: Vec<u8>,
    config: ObservationConfig,
    root: PathBuf,
    root_id: (u64, u64),
    deadline: Instant,
}

impl Store {
    /// `config_raw = private_bytes(path)`, then `configuration`, then
    /// `state_directory`; the deadline starts before the first read.
    pub fn open(owner: Owner, config_path: &Path) -> Result<Self, Refused> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let (config_raw, config) = owner.configuration(config_path)?;
        let (root, root_id) = owner.state_directory(&config)?;
        Ok(Self {
            owner,
            config_path: config_path.to_path_buf(),
            config_raw,
            config,
            root,
            root_id,
            deadline,
        })
    }

    #[must_use]
    pub fn config(&self) -> &ObservationConfig {
        &self.config
    }
}

impl HistorySource for Store {
    fn entries(&mut self) -> Result<Vec<String>, Refused> {
        let refusal = Refused("History entries unavailable");
        let mut names = Vec::new();
        for entry in std::fs::read_dir(&self.root).map_err(|_| refusal)? {
            let name = entry.map_err(|_| refusal)?.file_name();
            // A non-UTF-8 name never matches FILES; it only counts and sorts.
            names.push(name.to_string_lossy().into_owned());
            if names.len() > ENTRY_LIMIT {
                return Err(Refused("History file bound exceeded"));
            }
        }
        names.sort();
        Ok(names)
    }

    fn read(&mut self, name: &str) -> Result<Vec<u8>, Refused> {
        self.owner.private_bytes(&self.root.join(name), FILE_LIMIT)
    }

    fn tail(&mut self, name: &str) -> Result<Tail, Refused> {
        self.owner.freshness_tail(&self.root.join(name))
    }

    fn expired(&self) -> bool {
        Instant::now() >= self.deadline
    }

    /// The selected configuration and state are unchanged after every read.
    fn recheck(&mut self) -> Result<(), Refused> {
        let changed = Refused("History source changed");
        let (raw, config) = self.owner.configuration(&self.config_path)?;
        let (root, root_id) = self.owner.state_directory(&config)?;
        if raw != self.config_raw
            || config != self.config
            || root != self.root
            || root_id != self.root_id
        {
            return Err(changed);
        }
        Ok(())
    }
}

/// `query(path, start, end, resolution, gpu)`: the output bytes, without the newline.
pub fn query(
    owner: Owner,
    config_path: &Path,
    request: &HistoryRequest,
) -> Result<Vec<u8>, Refused> {
    let mut store = Store::open(owner, config_path)?;
    let config = store.config().clone();
    reverie_contracts::resource_history::query(&mut store, &config, request)
}
