use super::*;
use serde_json::Value;
mod recipe;
pub(in crate::worker_service) use recipe::ExpectedCommands;
const SERVICE: &str = "org.freedesktop.systemd1";
const OBJECT: &str = "/org/freedesktop/systemd1/unit/reverie_2dworker_2dbroker_2eservice";
const SERVICE_INTERFACE: &str = "org.freedesktop.systemd1.Service";
const UNIT_INTERFACE: &str = "org.freedesktop.systemd1.Unit";

pub(in crate::worker_service) struct BusReader {
    client: Arc<CapturedClient>,
    call: Option<CapturedCall>,
    end: Instant,
    last: Option<(Vec<u8>, Vec<u8>, u8)>,
    uncertain: bool,
}
#[derive(Eq, PartialEq)]
pub(in crate::worker_service) struct ServiceGroupData {
    pub(in crate::worker_service) slice: String,
    pub(in crate::worker_service) group: String,
    pub(in crate::worker_service) pid: u32,
    invocation: Vec<u8>,
}
impl BusReader {
    pub(in crate::worker_service) fn capture(state: &State) -> Result<Self> {
        let program = PathBuf::from(option_env!("REVERIE_FIXED_NATIVE_WORKER_BUSCTL").ok_or(
            WorkerServiceError::Refused("NATIVE_STOPPED_SERVICE_PACKAGED_BUS_REQUIRED"),
        )?);
        immutable_tool(&program)?;
        Self::at(state, &program)
    }
    fn at(state: &State, program: &Path) -> Result<Self> {
        let command = InstalledCommand::from_snapshot(
            program.as_os_str(),
            manager_environment(&state.home),
            state.home.clone(),
            false,
        )
        .ok_or(WorkerServiceError::Refused(
            "NATIVE_STOPPED_SERVICE_BUS_CAPTURE",
        ))?;
        Ok(Self {
            client: Arc::new(CapturedClient::new(command)),
            call: None,
            end: state.end,
            last: None,
            uncertain: false,
        })
    }
    pub(in crate::worker_service) fn verify(&mut self, expected: &ExpectedCommands) -> Result<()> {
        self.quiescent()?;
        let start = self.property(SERVICE_INTERFACE, "ExecStart", "a(sasbttttuii)")?;
        expected.assert_start(&start, false)?;
        let pre = self.property(SERVICE_INTERFACE, "ExecStartPre", "a(sasbttttuii)")?;
        expected.assert_start(&pre, true)?;
        let environment = self.property(SERVICE_INTERFACE, "EnvironmentFiles", "a(sb)")?;
        expected.assert_environment(&environment)?;
        self.quiescent()
    }
    fn quiescent(&mut self) -> Result<()> {
        for property in ["MainPID", "ControlPID"] {
            need(
                self.property(SERVICE_INTERFACE, property, "u")?.as_u64() == Some(0),
                "NATIVE_STOPPED_SERVICE_PROCESS_ACTIVE",
            )?;
        }
        let job = self.property(UNIT_INTERFACE, "Job", "(uo)")?;
        need(
            job == serde_json::json!([0, "/"]),
            "NATIVE_STOPPED_SERVICE_JOB_ACTIVE",
        )
    }
    pub(in crate::worker_service) fn control_group(&mut self) -> Result<String> {
        self.property(SERVICE_INTERFACE, "ControlGroup", "s")?
            .as_str()
            .map(str::to_owned)
            .ok_or(WorkerServiceError::Refused(
                "NATIVE_SERVICE_CONTROL_GROUP_REPLY",
            ))
    }
    pub(in crate::worker_service) fn stopped_group(&mut self) -> Result<ServiceGroupData> {
        self.quiescent()?;
        let slice = self
            .property(SERVICE_INTERFACE, "Slice", "s")?
            .as_str()
            .map(str::to_owned)
            .ok_or(WorkerServiceError::Refused("NATIVE_SERVICE_SLICE_REPLY"))?;
        need(
            slice.ends_with(".slice")
                && slice.len() <= 255
                && slice
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_')),
            "NATIVE_SERVICE_SLICE_REPLY",
        )?;
        let escaped = slice
            .bytes()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    char::from(c).to_string()
                } else {
                    format!("_{c:02x}")
                }
            })
            .collect::<String>();
        let object = format!("/org/freedesktop/systemd1/unit/{escaped}");
        let group = self
            .property_on(
                &object,
                "org.freedesktop.systemd1.Slice",
                "ControlGroup",
                "s",
            )?
            .as_str()
            .map(str::to_owned)
            .ok_or(WorkerServiceError::Refused(
                "NATIVE_SERVICE_SLICE_GROUP_REPLY",
            ))?;
        let pid = self
            .property(SERVICE_INTERFACE, "ExecMainPID", "u")?
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or(WorkerServiceError::Refused("NATIVE_SERVICE_LAST_PID_REPLY"))?;
        let invocation = self
            .property(UNIT_INTERFACE, "InvocationID", "ay")?
            .as_array()
            .and_then(|a| {
                a.iter()
                    .map(|v| v.as_u64().and_then(|v| u8::try_from(v).ok()))
                    .collect::<Option<Vec<_>>>()
            })
            .filter(|a| a.len() == 16 && a.iter().any(|b| *b != 0))
            .ok_or(WorkerServiceError::Refused(
                "NATIVE_SERVICE_INVOCATION_REPLY",
            ))?;
        self.quiescent()?;
        Ok(ServiceGroupData {
            slice,
            group,
            pid,
            invocation,
        })
    }
    fn property(&mut self, interface: &str, property: &str, signature: &str) -> Result<Value> {
        self.property_on(OBJECT, interface, property, signature)
    }
    fn property_on(
        &mut self,
        object: &str,
        interface: &str,
        property: &str,
        signature: &str,
    ) -> Result<Value> {
        need(
            self.call.is_none() && Instant::now() < self.end,
            "NATIVE_STOPPED_SERVICE_ORIGINAL_BUS_RETAINED",
        )?;
        let arguments = [
            "--user",
            "--json=short",
            "get-property",
            SERVICE,
            object,
            interface,
            property,
        ]
        .map(OsString::from)
        .to_vec();
        let output = match self.client.run_scoped(
            arguments,
            self.end,
            &CancellationToken::new(),
            Policy {
                maximum: Duration::from_secs(3),
                maximum_output: 65_536,
                successful_exit: false,
            },
        ) {
            Ok(output) => output,
            Err(failure) => {
                self.call = failure.call;
                return Err(WorkerServiceError::Engine(failure.error.into()));
            }
        };
        let success = output.succeeded;
        self.last = Some((output.stdout, output.stderr, output.shell_code));
        need(success, "NATIVE_STOPPED_SERVICE_BUS_REFUSED")?;
        let reply: Value =
            serde_json::from_slice(&self.last.as_ref().expect("original bus bytes").0)
                .map_err(|_| WorkerServiceError::Refused("NATIVE_STOPPED_SERVICE_BUS_REPLY"))?;
        let fields = reply.as_object().ok_or(WorkerServiceError::Refused(
            "NATIVE_STOPPED_SERVICE_BUS_REPLY",
        ))?;
        need(
            fields.len() == 2
                && fields.get("type").and_then(Value::as_str) == Some(signature)
                && fields.contains_key("data"),
            "NATIVE_STOPPED_SERVICE_BUS_REPLY",
        )?;
        Ok(fields["data"].clone())
    }
    pub(in crate::worker_service) fn close(&mut self) -> Result<()> {
        let mut result = self
            .client
            .settle_owned(self.end)
            .map_err(|error| WorkerServiceError::Engine(error.into()));
        if let Some(call) = self.call.as_ref() {
            let closed = self
                .client
                .settle_call(call, self.end)
                .map_err(|error| WorkerServiceError::Engine(error.into()));
            if closed.is_ok() {
                self.call = None;
            }
            result = finalized(result, closed);
        }
        result = finalized(
            result,
            self.client
                .close(self.end)
                .map_err(|error| WorkerServiceError::Engine(error.into())),
        );
        self.uncertain |= result.is_err();
        if self.uncertain {
            result = finalized(
                result,
                Err(WorkerServiceError::Refused(
                    "NATIVE_STOPPED_SERVICE_BUS_CLOSE_UNCONFIRMED",
                )),
            );
        }
        result
    }
    #[cfg(test)]
    pub(in crate::worker_service) fn controlled(state: &State) -> Result<Self> {
        let program = state.home.join("native-worker-service-bus");
        if !program.exists() {
            fs::hard_link(crate::engine_metadata::tests::program(), &program)?;
        }
        Self::at(state, &program)
    }
}
