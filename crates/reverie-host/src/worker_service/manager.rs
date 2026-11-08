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
                    "LoadState" | "ActiveState" | "SubState" | "FragmentPath"
                ) && values.insert(key, value).is_none(),
                "NATIVE_SERVICE_MANAGER_REPLY",
            )?;
        }
        need(values.len() == 4, "NATIVE_SERVICE_MANAGER_REPLY")?;
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
                maximum: Duration::from_secs(5),
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
        ])?;
        ObservedUnit::decode(&raw)
    }
    pub(super) fn assert_installed(&mut self, observed: &ObservedUnit) -> Result<()> {
        need(
            observed.load == "loaded" && observed.fragment == self.unit,
            "NATIVE_SERVICE_CURRENT_GENERATION_REQUIRED",
        )?;
        let link = self.home.join(".config/systemd/user").join(UNIT);
        need(
            fs::read_link(link)? == self.unit,
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
