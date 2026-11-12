use super::*;
impl NominationOwner {
    pub(super) fn assert_preflight(&self) -> Result<()> {
        self.current()?;
        self.assert_input_metadata()?;
        self.immutable.assert_finalized()?;
        self.assert_source()?;
        if let Some(derived) = &self.derived {
            derived.assert_metadata(&self.config)?;
        }
        self.assert_input_metadata()?;
        self.current()
    }
    fn assert_input_metadata(&self) -> Result<()> {
        let input = self.input.as_ref().expect("retained original input");
        input.check()?;
        PrivateBatch::check_exact_private_json(
            &self.selection,
            self.input_stamp.as_ref().expect("original input stamp"),
        )?;
        let directory = self.directories.as_ref().expect("original fixed directory");
        directory.assert_directory(0)?;
        directory.assert_directory(1)?;
        need(
            self.stores
                .as_ref()
                .expect("original protected stores")
                .unchanged()?,
            "POOL_NOMINATION_PROTECTED_STORE_CHANGED",
        )?;
        Ok(())
    }
    pub(super) fn publish(&mut self) -> Result<PoolNominationPublished> {
        self.assert_preflight()?;
        need(!self.attempted, "POOL_NOMINATION_ALREADY_ATTEMPTED")?;
        self.attempted = true;
        let directory = self.directories.as_ref().expect("original fixed directory");
        self.output = Some(native::create_policy_temporary(
            &directory.directories[1],
            std::ffi::OsStr::new("registration-request.json"),
        )?);
        let output = self
            .output
            .as_mut()
            .expect("retained exclusive output before write");
        output.set_permissions(fs::Permissions::from_mode(0o600))?;
        output.write_all(self.raw.as_ref().expect("original selected bytes"))?;
        output.sync_all()?;
        let info = output.metadata()?;
        need(
            info.uid() == native::uid()
                && info.gid() == nix::unistd::getegid().as_raw()
                && info.mode() & 0o7777 == 0o600
                && info.nlink() == 1,
            "POOL_NOMINATION_PRIVATE_OUTPUT",
        )?;
        self.output_stamp = Some(native::PrivateFileStamp::of(&info));
        self.close_output()?;
        self.readback()?;
        self.assert_preflight()?;
        self.assert_output_metadata()?;
        let directory = self.directories.as_ref().expect("original fixed directory");
        Ok(PoolNominationPublished {
            path: directory.root.join("worker-pool/registration-request.json"),
            digest: self
                .request
                .as_ref()
                .expect("same nominated request")
                .digest()
                .as_str()
                .to_owned(),
            canonical: self
                .request
                .as_ref()
                .expect("same nominated request")
                .canonical_bytes()
                .to_vec(),
            proposed_from_hard: self.proposed_from_hard.clone(),
        })
    }
    fn readback(&self) -> Result<()> {
        let directory = self.directories.as_ref().expect("original fixed directory");
        directory.directories[1].sync_all()?;
        let path = PathBuf::from(format!(
            "/proc/self/fd/{}/registration-request.json",
            directory.directories[1].as_raw_fd()
        ));
        let before = native::PrivateFileStamp::of(&fs::symlink_metadata(&path)?);
        need(
            self.output_stamp.as_ref() == Some(&before),
            "POOL_NOMINATION_OUTPUT_CHANGED",
        )?;
        let raw = native::observe(&path, 65_536, |info| {
            info.uid() == native::uid()
                && info.gid() == nix::unistd::getegid().as_raw()
                && info.mode() & 0o7777 == 0o600
                && info.nlink() == 1
        })?;
        need(
            self.raw.as_ref() == Some(&raw)
                && native::PrivateFileStamp::of(&fs::symlink_metadata(path)?) == before,
            "POOL_NOMINATION_OUTPUT_CHANGED",
        )
    }
    fn close_output(&mut self) -> Result<()> {
        self.output
            .take()
            .map_or(Ok(()), |file| native::close(file).map_err(Into::into))
    }
    fn assert_output_metadata(&self) -> Result<()> {
        let root = &self
            .directories
            .as_ref()
            .expect("original fixed directory")
            .root;
        let info = fs::symlink_metadata(root.join("worker-pool/registration-request.json"))?;
        need(
            self.output_stamp.as_ref() == Some(&native::PrivateFileStamp::of(&info)),
            "POOL_NOMINATION_OUTPUT_CHANGED",
        )
    }
    pub(super) fn assert_terminal_metadata(&self) -> Result<()> {
        self.current()?;
        need(
            self.runtime_closed && self.output.is_none(),
            "POOL_NOMINATION_COMPONENTS_NOT_CLOSED",
        )?;
        self.assert_directory_names()?;
        self.input
            .as_ref()
            .expect("original closed input")
            .check()?;
        PrivateBatch::check_exact_private_json(
            &self.selection,
            self.input_stamp.as_ref().expect("original input stamp"),
        )?;
        let source = self.source.as_ref().expect("original selected source");
        need(
            crate::gpu_access::GpuFileStamp::observe(source)?
                == *self.before.as_ref().expect("original source stamp").stamp(),
            "POOL_NOMINATION_CONFIGURATION_CHANGED",
        )?;
        need(
            self.stores.as_ref().expect("original stores").unchanged()?,
            "POOL_NOMINATION_PROTECTED_STORE_CHANGED",
        )?;
        self.assert_output_metadata()?;
        if let Some(derived) = &self.derived {
            derived.assert_metadata(&self.config)?;
        }
        self.assert_directory_names()?;
        self.current()
    }
    fn assert_directory_names(&self) -> Result<()> {
        for (path, identity) in &self.directory_identities {
            let info = fs::symlink_metadata(path)?;
            need(
                !info.file_type().is_symlink()
                    && native::private_goal::identity(&info) == *identity,
                "POOL_NOMINATION_DIRECTORY_CHANGED",
            )?;
        }
        Ok(())
    }
    pub(super) fn close_preflight(&mut self) -> Result<()> {
        let input = self
            .input
            .as_mut()
            .map_or(Ok(()), |input| input.close().map_err(Into::into));
        let target = self.target.as_mut().map_or(Ok(()), |target| {
            target.close(&self.runtime).map_err(Into::into)
        });
        let immutable = self.immutable.assert_finalized().map_err(Into::into);
        let derived = self
            .derived
            .as_mut()
            .map_or(Ok(()), NominationDerivation::close);
        finalized(finalized(input, target), finalized(immutable, derived))
    }
    pub(super) fn close(&mut self) -> Result<()> {
        let output = self.close_output();
        let preflight = self.close_preflight();
        let runtime = if self.runtime_closed {
            Ok(())
        } else {
            self.runtime
                .close(self.end)
                .map(|()| self.runtime_closed = true)
                .map_err(Into::into)
        };
        let directory = self
            .directories
            .as_mut()
            .map_or(Ok(()), |owner| owner.close().map_err(Into::into));
        finalized(finalized(finalized(output, preflight), runtime), directory)
    }
}
