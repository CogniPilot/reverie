//! Bound read-side classifications; these values grant no effect authority.
use super::*;

pub struct CustodyInventory<'a> {
    rows: &'a InventoryRows,
    stopped: BTreeMap<ContainerId, StoppedState>,
}
impl<'a> CustodyInventory<'a> {
    pub fn new(rows: &'a InventoryRows) -> Self {
        Self {
            rows,
            stopped: BTreeMap::new(),
        }
    }
    pub fn rows(&self) -> &InventoryRows {
        self.rows
    }
    pub fn stopped(&self, row: &ContainerRow) -> Option<&StoppedState> {
        self.stopped.get(row.id())
    }
    pub fn stopped_ids(&self) -> impl Iterator<Item = &ContainerId> {
        self.stopped.keys()
    }
    fn row(&self, id: &ContainerId) -> Result<&ContainerRow> {
        self.rows
            .rows()
            .iter()
            .find(|row| row.id() == id)
            .ok_or(EngineDataError::StoppedChanged)
    }
    pub fn observe_stopped(&mut self, id: &ContainerId, stdout: &str) -> Result<()> {
        if self.stopped.contains_key(id) {
            return Err(EngineDataError::StoppedChanged);
        }
        let row = self.row(id)?;
        let state = StoppedState::capture(row, stdout)?;
        if !state.permits_future_mount_source(row)? {
            return Err(EngineDataError::StoppedChanged);
        }
        self.stopped.insert(id.clone(), state);
        Ok(())
    }
    pub fn assert_stopped_current(&self, id: &ContainerId, stdout: &str) -> Result<()> {
        let state = StoppedState::capture(self.row(id)?, stdout)?;
        let original = self
            .stopped
            .get(id)
            .ok_or(EngineDataError::StoppedChanged)?;
        if state.state_bytes() != original.state_bytes() {
            return Err(EngineDataError::StoppedChanged);
        }
        Ok(())
    }
}
