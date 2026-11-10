use super::*;
use sha2::Digest;
impl Retirement {
    pub(in crate::worker_pool::installation_request::nomination::revision) fn publish(
        &mut self,
        owner: &mut NominationOwner,
        publication: &publication::Publication,
        locks: &mut ImageMaintenanceLocks,
        service: &ImageServiceMaintenance,
    ) -> Result<()> {
        need(!self.attempted, "POOL_RETIRE_ALREADY_ATTEMPTED")?;
        self.assert_current(owner)?;
        publication.assert_history_bound(owner)?;
        publication::fence(owner, locks, service)?;
        let nonce = publication
            .history_path()
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or(PoolNominationError::Refused("POOL_RETIRE_HISTORY_NAME"))?;
        let name = format!(
            "{}-failed-{nonce}",
            owner
                .request
                .as_ref()
                .expect("original policy")
                .policy()
                .controller_name()
        );
        self.retired_name = Some(name.clone());
        self.attempted = true;
        let id = self
            .id
            .as_ref()
            .expect("derived exact CID")
            .as_str()
            .to_owned();
        self.rename_output =
            Some(self.call(owner, ["rename", &id, &name].map(Into::into).to_vec())?);
        let output = self.rename_output.as_ref().expect("retained rename reply");
        need(
            output.stdout.is_empty() && output.stderr.is_empty(),
            "POOL_RETIRE_RENAME_OUTPUT",
        )?;
        self.retired = true;
        self.assert_current(owner)?;
        publication::fence(owner, locks, service)?;
        publication.assert_history_bound(owner)?;
        self.namespace.archive(owner, publication, locks, service)?;
        self.assert_current(owner)?;
        publication::fence(owner, locks, service)?;
        self.write_receipt(owner, publication)?;
        self.assert_metadata()
    }
    fn write_receipt(
        &mut self,
        owner: &NominationOwner,
        publication: &publication::Publication,
    ) -> Result<()> {
        publication.assert_history_bound(owner)?;
        self.receipt_path = Some(publication.history_path().join("retired-negative.json"));
        self.receipt = Some(native::create_policy_temporary(
            publication.history_fd(),
            std::ffi::OsStr::new("retired-negative.json"),
        )?);
        let raw = serde_json::to_vec(&serde_json::json!({"version":1,
            "purpose":"reverie-failed-pool-installation-retired-negative-v1",
            "originalRequestDigest":owner.request.as_ref().expect("original proposal").digest().as_str(),
            "containerId":self.id.as_ref().expect("exact original CID").as_str(),
            "retiredName":self.retired_name,"birthDigest":self.birth,
            "originalInspectionSHA256":format!("{:x}",sha2::Sha256::digest(self.original.as_ref().expect("whole original raw"))),
            "stdoutSHA256":format!("{:x}",sha2::Sha256::digest(&self.logs.as_ref().expect("actual logs").stdout)),
            "stderrSHA256":format!("{:x}",sha2::Sha256::digest(&self.logs.as_ref().expect("actual logs").stderr)),
            "originalInspectionBytes":self.original,"containerStdout":self.logs.as_ref().expect("original logs").stdout,
            "containerStderr":self.logs.as_ref().expect("original logs").stderr,
            "originalActivationCompleted":false,"resumeAuthorized":false,"workersStarted":false}))
            .map_err(|_| PoolNominationError::Refused("POOL_RETIRE_RECEIPT"))?;
        let file = self.receipt.as_mut().expect("retained before write");
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        file.write_all(&raw)?;
        file.sync_all()?;
        let info = file.metadata()?;
        need(
            info.uid() == native::uid() && info.mode() & 0o7777 == 0o600 && info.nlink() == 1,
            "POOL_RETIRE_RECEIPT_CUSTODY",
        )?;
        self.receipt_stamp = Some(native::PrivateFileStamp::of(&info));
        publication.history_fd().sync_all()?;
        Ok(())
    }
}
