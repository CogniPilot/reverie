use super::*;
pub(super) struct ObservedUnit {
    pub(super) load: String,
    pub(super) active: String,
    sub: String,
    pub(super) fragment: PathBuf,
}
impl ObservedUnit {
    pub(super) fn decode(raw: &str) -> Result<Self> {
        let mut values = std::collections::BTreeMap::new();
        for line in raw.lines() {
            let (key, value) = line
                .split_once('=')
                .ok_or(WorkerServiceError::Refused("NATIVE_SERVICE_MANAGER_REPLY"))?;
            need(
                matches!(
                    key,
                    "LoadState"
                        | "ActiveState"
                        | "SubState"
                        | "FragmentPath"
                        | "DropInPaths"
                        | "NeedDaemonReload"
                ) && values.insert(key, value).is_none(),
                "NATIVE_SERVICE_MANAGER_REPLY",
            )?;
        }
        need(values.len() == 6, "NATIVE_SERVICE_MANAGER_REPLY")?;
        need(
            values["NeedDaemonReload"] == "no",
            "NATIVE_SERVICE_STALE_MANAGER_UNIT",
        )?;
        need(
            values["DropInPaths"].is_empty(),
            "NATIVE_SERVICE_DROPIN_OVERRIDE_REFUSED",
        )?;
        Ok(Self {
            load: values["LoadState"].into(),
            active: values["ActiveState"].into(),
            sub: values["SubState"].into(),
            fragment: values["FragmentPath"].into(),
        })
    }
    pub(super) fn require_action_finished(&self, action: &WorkerServiceAction) -> Result<()> {
        let expected = match action {
            WorkerServiceAction::Start => self.active == "active" && self.sub == "running",
            WorkerServiceAction::Stop | WorkerServiceAction::Install => {
                self.active == "inactive" && self.sub == "dead"
            }
            WorkerServiceAction::Status => true,
            WorkerServiceAction::Rollback { .. } => self.active == "inactive" && self.sub == "dead",
        };
        need(expected, "NATIVE_SERVICE_POST_COMMAND_STATE_UNCONFIRMED")
    }
    pub(super) fn require_replaceable(&self, previous: Option<&Path>) -> Result<()> {
        need(
            self.active == "inactive" || self.active == "failed",
            "NATIVE_SERVICE_MUST_BE_INACTIVE",
        )?;
        if self.load == "not-found" {
            return need(
                self.fragment.as_os_str().is_empty(),
                "NATIVE_SERVICE_UNKNOWN_GENERATION",
            );
        }
        need(
            self.load == "loaded" && previous.is_some_and(|p| p == self.fragment),
            "NATIVE_SERVICE_UNKNOWN_GENERATION",
        )
    }
}
impl State {
    pub(super) fn command(&mut self, args: &[&str]) -> Result<String> {
        need(
            self.call.is_none() && Instant::now() < self.end,
            "NATIVE_SERVICE_ORIGINAL_CALL_RETAINED",
        )?;
        let mut words = vec![OsString::from("--user")];
        words.extend(args.iter().map(OsString::from));
        match self.client.run_scoped(
            words,
            self.end,
            &CancellationToken::new(),
            Policy {
                maximum: Duration::from_secs(if args.first() == Some(&"stop") { 40 } else { 5 }),
                maximum_output: 65_536,
                successful_exit: false,
            },
        ) {
            Ok(output) => {
                let success = output.succeeded;
                self.last = Some((output.stdout, output.stderr, output.shell_code));
                need(success, "NATIVE_SERVICE_MANAGER_REFUSED")?;
                String::from_utf8(self.last.as_ref().expect("original output").0.clone())
                    .map_err(|_| WorkerServiceError::Refused("NATIVE_SERVICE_MANAGER_UTF8"))
            }
            Err(failure) => {
                self.call = failure.call;
                self.uncertain |= self.attempted;
                Err(WorkerServiceError::Engine(failure.error.into()))
            }
        }
    }
    pub(super) fn observe(&mut self) -> Result<ObservedUnit> {
        // Explicit property values in fixed order; unknown/missing fields refuse.
        let raw = self.command(&[
            "show",
            UNIT,
            "--property=LoadState",
            "--property=ActiveState",
            "--property=SubState",
            "--property=FragmentPath",
            "--property=DropInPaths",
            "--property=NeedDaemonReload",
        ])?;
        let mut observed = ObservedUnit::decode(&raw)?;
        if observed.fragment == self.home.join(".config/systemd/user").join(UNIT) {
            let target = self.selected_unit_link()?;
            need(
                target == self.unit || self.previous.as_ref() == Some(&target),
                "NATIVE_SERVICE_UNKNOWN_GENERATION",
            )?;
            observed.fragment = target;
        }
        Ok(observed)
    }
    fn selected_unit_link(&self) -> Result<PathBuf> {
        let link = self.home.join(".config/systemd/user").join(UNIT);
        let m = fs::symlink_metadata(&link)?;
        need(
            m.file_type().is_symlink()
                && m.uid() == nix::unistd::geteuid().as_raw()
                && m.nlink() == 1,
            "NATIVE_SERVICE_UNIT_LINK_CHANGED",
        )?;
        Ok(fs::read_link(link)?)
    }
    pub(super) fn assert_stoppable(&mut self, observed: &ObservedUnit) -> Result<()> {
        if observed.fragment == self.unit {
            return self.assert_installed(observed);
        }
        let previous = self.previous.as_ref().ok_or(WorkerServiceError::Refused(
            "NATIVE_SERVICE_PREDECESSOR_NOT_PACKAGED",
        ))?;
        need(
            observed.load == "loaded" && observed.fragment == *previous,
            "NATIVE_SERVICE_UNKNOWN_PREDECESSOR",
        )?;
        need(
            self.selected_unit_link()? == *previous,
            "NATIVE_SERVICE_PREDECESSOR_LINK_CHANGED",
        )?;
        self.assert_legacy_selection()
    }
    pub(super) fn assert_legacy_selection(&mut self) -> Result<()> {
        let path = self.home.join(".config/reverie/worker-broker.env");
        need(
            self.read_private(&path)? == environment(&self.source)?,
            "NATIVE_SERVICE_PREDECESSOR_SOURCE_CHANGED",
        )
    }
    pub(super) fn assert_installed(&mut self, observed: &ObservedUnit) -> Result<()> {
        need(
            observed.load == "loaded" && observed.fragment == self.unit,
            "NATIVE_SERVICE_CURRENT_GENERATION_REQUIRED",
        )?;
        need(
            self.selected_unit_link()? == self.unit,
            "NATIVE_SERVICE_CURRENT_UNIT_REQUIRED",
        )?;
        let path = self.root.join("worker-pool/service/environment");
        private(&path, false)?;
        need(
            self.read_private(&path)? == environment(&self.source)?,
            "NATIVE_SERVICE_SELECTION_CHANGED",
        )
    }
}

impl State {
    pub(super) fn pin_package(&mut self) -> Result<()> {
        let package = self
            .unit
            .ancestors()
            .nth(4)
            .ok_or(WorkerServiceError::Refused("NATIVE_SERVICE_PACKAGE_ROOT"))?;
        let args = vec![
            OsString::from("--store"),
            OsString::from("daemon"),
            OsString::from("--add-root"),
            self.folder().join("gcroot").into_os_string(),
            OsString::from("--indirect"),
            OsString::from("--realise"),
            package.as_os_str().to_owned(),
        ];
        self.attempted = true;
        self.uncertain = true;
        match self.pin.run_scoped(
            args,
            self.end,
            &CancellationToken::new(),
            Policy {
                maximum: Duration::from_secs(5),
                maximum_output: 65536,
                successful_exit: false,
            },
        ) {
            Ok(output) => {
                let success = output.succeeded;
                self.last = Some((output.stdout, output.stderr, output.shell_code));
                need(success, "NATIVE_SERVICE_PIN_REFUSED")?;
                self.uncertain = false;
                Ok(())
            }
            Err(failure) => {
                self.pin_call = failure.call;
                Err(WorkerServiceError::Engine(failure.error.into()))
            }
        }
    }
}
