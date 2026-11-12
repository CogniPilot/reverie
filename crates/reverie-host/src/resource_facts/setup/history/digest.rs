//! Closed native observation fingerprint DATA; no path, raw request, receipt
//! or other private contents are serialized into the public setup preview.
use super::*;
use reverie_core::operations::JournalDigest;
use sha2::{Digest, Sha256};
use std::os::unix::ffi::OsStrExt;

impl ActorSetupHistoryObservation {
    pub fn binding_digest(&self) -> std::result::Result<JournalDigest, Rc<ActorSetupHistoryError>> {
        self.assert_current()?;
        let snapshot = self.snapshot.as_ref().expect("actual observed snapshot");
        let mut digest = Sha256::new();
        part(&mut digest, b"reverie-actor-setup-history-v1");
        for directory in &snapshot.directories {
            part(&mut digest, b"directory");
            part(&mut digest, directory.path.as_os_str().as_bytes());
            for value in &directory.projection {
                part(&mut digest, value.as_bytes());
            }
            part(&mut digest, &directory.group.to_be_bytes());
            for name in &directory.names {
                part(&mut digest, name.as_bytes());
            }
            part(&mut digest, b"end-directory");
        }
        for record in &snapshot.records {
            part(&mut digest, b"record");
            part(&mut digest, record.path.as_os_str().as_bytes());
            for value in native::private_goal::projection(&record.stamp) {
                part(&mut digest, value.as_bytes());
            }
            part(&mut digest, &record.group.to_be_bytes());
            match record.digest {
                Some(value) => {
                    part(&mut digest, b"bytes");
                    part(&mut digest, &value);
                }
                None => part(&mut digest, b"lock-metadata"),
            }
        }
        let hex: String = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(JournalDigest::parse(&hex).expect("actual SHA256"))
    }
}
fn part(digest: &mut Sha256, value: &[u8]) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value);
}
