use super::*;
impl SetupState {
    pub(super) fn read_configuration(&mut self) -> SetupResult<GpuPrivateSnapshot> {
        self.live()?;
        let value = self.host(self.files.read_configuration())?;
        let path = self.host(self.files.source().map(Path::to_owned))?;
        let observed = (
            value.stamp().clone(),
            self.host(group(&path, value.stamp()))?,
        );
        if self
            .captured_source
            .as_ref()
            .is_some_and(|old| old != &observed)
        {
            return Err(self.refuse("ACTOR_SETUP_SOURCE_CHANGED"));
        }
        self.captured_source = Some(observed);
        Ok(value)
    }
    pub(super) fn read_binding(&mut self) -> SetupResult<GpuPrivateSnapshot> {
        self.live()?;
        let value = self.host(self.files.read_binding())?;
        let path = self.host(self.files.binding_path())?;
        let observed = (
            value.stamp().clone(),
            self.host(group(&path, value.stamp()))?,
        );
        if self
            .captured_binding
            .as_ref()
            .is_some_and(|old| old != &observed)
        {
            return Err(self.refuse("ACTOR_SETUP_BINDING_CHANGED"));
        }
        self.captured_binding = Some(observed);
        Ok(value)
    }
    pub(super) fn prepare_transition(
        &mut self,
        binding: &ControlBinding,
    ) -> SetupResult<Arc<ActorSetupTransition>> {
        self.live()?;
        if let Some(intent) = &self.intent {
            self.host(self.assert_before())?;
            self.host(need(
                intent.before_binding().domain() == binding.domain()
                    && binding.matches_metadata(
                        self.binding.as_ref().expect("original binding").metadata(),
                    ),
                "ACTOR_SETUP_BINDING_CHANGED",
            ))?;
            return Ok(intent.clone());
        }
        let configuration = self.read_configuration()?;
        let current_binding = self.read_binding()?;
        self.host(need(
            binding.matches_metadata(current_binding.metadata()),
            "ACTOR_SETUP_BINDING_CHANGED",
        ))?;
        self.host(need(
            reverie_contracts::gpu_access::private_config_matches(
                self.files.config.configuration(),
                configuration.metadata(),
            ),
            "ACTOR_SETUP_CONFIGURATION_CHANGED",
        ))?;
        let source = self.host(self.files.source().map(Path::to_owned))?;
        let uid = self.host(self.files.config.uid().map_err(GpuHostError::from))?;
        let raw = self.host(read_raw(&source, configuration.stamp(), uid))?;
        let intent = Arc::new(
            ActorSetupTransition::prepare(self.files.config.configuration(), &raw, binding)
                .map_err(|e| {
                    self.causes
                        .borrow_mut()
                        .record(ActorSetupControlError::Data(e))
                })?,
        );
        let path = self.host(self.files.binding_path())?;
        self.groups = Some((
            self.host(group(&source, configuration.stamp()))?,
            self.host(group(&path, current_binding.stamp()))?,
        ));
        self.source = Some(configuration);
        self.binding = Some(current_binding);
        self.raw = Some(raw);
        self.intent = Some(intent.clone());
        Ok(intent)
    }
    pub(super) fn assert_before(&self) -> Result<()> {
        let intent = self
            .intent
            .as_ref()
            .ok_or(GpuHostError::Refused("ACTOR_SETUP_UNPREPARED"))?;
        let configuration = self.files.read_configuration()?;
        let binding = self.files.read_binding()?;
        let source = self.source.as_ref().expect("stored source");
        let before_binding = self.binding.as_ref().expect("stored binding");
        need(
            configuration.stamp() == source.stamp()
                && binding.stamp() == before_binding.stamp()
                && intent.matches_before_configuration(configuration.metadata())
                && intent.matches_before_binding(binding.metadata()),
            "ACTOR_SETUP_SOURCE_CHANGED",
        )?;
        let original_raw = self.raw.as_ref().expect("stored original source bytes");
        need(
            read_raw(
                self.files.source()?,
                source.stamp(),
                self.files.config.uid()?,
            )? == *original_raw,
            "ACTOR_SETUP_SOURCE_CHANGED",
        )?;
        let groups = self.groups.expect("stored groups");
        need(
            group(self.files.source()?, source.stamp())? == groups.0
                && group(&self.files.binding_path()?, before_binding.stamp())? == groups.1,
            "ACTOR_SETUP_SOURCE_GROUP_CHANGED",
        )
    }
}
pub(super) fn group(path: &Path, stamp: &GpuFileStamp) -> Result<u32> {
    let info = fs::symlink_metadata(path)?;
    need(
        GpuFileStamp::of(&info) == *stamp,
        "ACTOR_SETUP_SOURCE_CHANGED",
    )?;
    Ok(info.gid())
}
fn read_raw(path: &Path, expected: &GpuFileStamp, uid: u32) -> Result<Vec<u8>> {
    let parent = path
        .parent()
        .ok_or(GpuHostError::Refused("ACTOR_SETUP_SOURCE_PARENT"))?;
    let leaf = path
        .file_name()
        .ok_or(GpuHostError::Refused("ACTOR_SETUP_SOURCE_PARENT"))?;
    let directory = open_parent(parent)?;
    let body = (|| {
        let mut file = native::open_at(
            directory.as_raw_fd(),
            leaf,
            libc::O_RDONLY | libc::O_NONBLOCK,
        )?;
        let read = (|| {
            need(
                GpuFileStamp::of(&file.metadata()?) == *expected && expected.private(uid),
                "ACTOR_SETUP_SOURCE_CHANGED",
            )?;
            let mut raw = Vec::new();
            (&mut file)
                .take(MAX_BYTES as u64 + 1)
                .read_to_end(&mut raw)?;
            need(
                raw.len() <= MAX_BYTES
                    && GpuFileStamp::of(&file.metadata()?) == *expected
                    && GpuFileStamp::named(&directory, leaf)? == *expected,
                "ACTOR_SETUP_SOURCE_CHANGED",
            )?;
            Ok(raw)
        })();
        finalized(read, native::close(file).map_err(Into::into))
    })();
    finalized(body, native::close(directory).map_err(Into::into))
}
