//! What the journal says about an operation's place in the claim history and
//! about the storage it wrote outside its own directory.
use super::*;

/// A rehearsal directory as it was pinned before the stop.
pub(crate) struct RecordedRoot {
    pub(crate) path: PathBuf,
    pub(crate) identity: (u64, u64),
}

impl Operation {
    /// The operation whose claim this one took over, as journaled at the
    /// handover. The first operation of an installation has none.
    pub(crate) fn predecessor(&self) -> Result<Option<String>> {
        if !self.record_present("claim-acquired")? {
            return Ok(None);
        }
        Ok(self.read_record("claim-acquired")?["predecessor"]
            .as_str()
            .map(str::to_owned))
    }
    /// This operation ended ready, restored or refused, and the named later
    /// operation took over its claim. Nothing can resume it.
    pub(crate) fn closed_and_superseded_by(&self, successor: &str) -> Result<bool> {
        Ok(self.status()?.stage == "SUPERSEDED"
            && self.read_record("superseded")?["successor"] == successor
            && ["ready", "restored", "invalid-create-refused"]
                .into_iter()
                .any(|receipt| self.exists(receipt) && self.receipt_valid(receipt)))
    }
    /// Journal, before anything is written there, the separate directory
    /// that will hold this operation's restore rehearsal. A repeated apply
    /// must name the same directory.
    pub(crate) fn record_rehearsal_root(&self, path: &Path, identity: (u64, u64)) -> Result<()> {
        let data = json!({"path":path,"device":identity.0,"inode":identity.1});
        if self.record_present("rehearsal-root")? {
            return require(
                self.read_record("rehearsal-root")? == data,
                "DEPLOYMENT_REHEARSAL_ROOT_CHANGED",
            );
        }
        self.record("rehearsal-root", &data)
    }
    pub(crate) fn rehearsal_root(&self) -> Result<Option<RecordedRoot>> {
        if !self.record_present("rehearsal-root")? {
            return Ok(None);
        }
        let data = self.read_record("rehearsal-root")?;
        let recorded = (|| {
            let path = PathBuf::from(data["path"].as_str()?);
            path.is_absolute().then_some(RecordedRoot {
                path,
                identity: (data["device"].as_u64()?, data["inode"].as_u64()?),
            })
        })();
        recorded
            .map(Some)
            .ok_or_else(|| DeploymentError::new("DEPLOYMENT_RECEIPT_UNCONFIRMED"))
    }
}
