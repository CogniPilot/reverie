use crate::{Error, Result};
use clap::{Parser, ValueEnum};
use serde_json::{Value, json};

#[derive(Parser, Debug)]
#[command(
    name = "reverie-worker-exec",
    version,
    about = "Connect to an owner-configured private Reverie laptop broker",
    long_about = "Linux client for the existing private worker broker. The broker independently checks all execution grants; endpoint access and resource references confer no authority.",
    after_help = "Examples:\n  reverie-worker-exec --session-id <UUID> --cwd /workspace --command 'git status'\n  reverie-worker-exec --control status\n  reverie-worker-exec --control stop-agent --session-id <UUID> --not-after <EPOCH_MS> --fence <32_HEX>\n\nREVERIE_WORKER_SOCKET selects the existing private broker endpoint. No broker is started. Failures are never retried; inspect retained operation state after a lost reply."
)]
pub(crate) struct Args {
    /// Existing office control operation. Owner authorization remains broker-side.
    #[arg(long, value_enum, help_heading = "Office control")]
    control: Option<Control>,
    /// Project fresh, closed host/server-only Goal custody metadata once.
    #[arg(long, help_heading = "Private metadata")]
    pub(crate) goal_custody: bool,
    /// Read G bytes from stdin and emit one framed custody reply for each byte.
    #[arg(long, help_heading = "Private metadata", conflicts_with_all=["goal_custody","control","command_failure_report","employee_id","caller_session","attach_only","resource_ref","session_id","not_after","fence","cwd","command"])]
    pub(crate) goal_custody_stream: bool,
    /// Read bounded self-reported command failure metadata; never command text.
    #[arg(long, help_heading = "Private metadata")]
    command_failure_report: bool,
    /// Employee to include in the failure report (repeatable, at most 64).
    #[arg(long, help_heading = "Private metadata")]
    employee_id: Vec<String>,
    /// Existing maintenance caller reference; never an owner grant.
    #[arg(long, help_heading = "Office control")]
    caller_session: Option<String>,
    /// Attach to an existing laptop without starting a new laptop.
    #[arg(long, help_heading = "Laptop terminal")]
    attach_only: bool,
    /// Server-private registered resource launch reference.
    #[arg(long, help_heading = "Laptop terminal")]
    resource_ref: Option<String>,
    /// Existing lowercase session UUID.
    #[arg(long, help_heading = "Laptop terminal")]
    session_id: Option<String>,
    /// stop-agent dispatch deadline in epoch milliseconds; never extends authority.
    #[arg(long, allow_hyphen_values = true, help_heading = "Office control")]
    not_after: Option<i64>,
    /// Exactly 32 lowercase hexadecimal digits, shared with settle-stop.
    #[arg(long, help_heading = "Office control")]
    fence: Option<String>,
    /// Absolute directory within the owner's existing laptop grants.
    #[arg(long, help_heading = "Laptop terminal")]
    cwd: Option<String>,
    /// Laptop command text; never executed by this client or on the host.
    #[arg(long, allow_hyphen_values = true, help_heading = "Laptop terminal")]
    command: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum Control {
    Status,
    ProviderHealth,
    /// Observe original live storage-owner kinds/phases; never reconcile or retry.
    StorageStatus,
    StopLaptops,
    Shutdown,
    RestartWebsite,
    ReloadResources,
    StopAgent,
    SettleStop,
}
impl Control {
    fn name(self) -> &'static str {
        match self {
            Self::Status => crate::control::Action::Status.name(),
            Self::ProviderHealth => crate::control::Action::ProviderHealth.name(),
            Self::StorageStatus => crate::control::Action::StorageStatus.name(),
            Self::StopLaptops => crate::control::Action::StopLaptops.name(),
            Self::Shutdown => "shutdown",
            Self::RestartWebsite => "restart-website",
            Self::ReloadResources => "reload-resources",
            Self::StopAgent => "stop-agent",
            Self::SettleStop => "settle-stop",
        }
    }
}
pub(crate) enum Operation {
    Launch {
        request: Value,
        reference: Option<String>,
    },
    Control(Value),
    Report(Vec<String>),
    Custody {
        stream: bool,
    },
}
pub(crate) fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
impl Args {
    fn has_launch(&self) -> bool {
        self.attach_only
            || self.resource_ref.is_some()
            || self.session_id.is_some()
            || self.cwd.is_some()
            || self.command.is_some()
    }
    pub(crate) fn operation(self) -> Result<Operation> {
        let custody = self.goal_custody || self.goal_custody_stream;
        if custody {
            if self.goal_custody && self.goal_custody_stream
                || self.has_launch()
                || self.control.is_some()
                || self.caller_session.is_some()
                || self.command_failure_report
                || !self.employee_id.is_empty()
                || self.not_after.is_some()
                || self.fence.is_some()
            {
                return Err(Error::new(
                    "Goal custody client accepts no operation or identity inputs",
                ));
            }
            return Ok(Operation::Custody {
                stream: self.goal_custody_stream,
            });
        }
        if self.command_failure_report {
            if self.has_launch()
                || self.control.is_some()
                || self.caller_session.is_some()
                || self.not_after.is_some()
                || self.fence.is_some()
            {
                return Err(Error::new("TELEMETRY_REPORT_REFUSED"));
            }
            crate::report::selected(&self.employee_id)?;
            return Ok(Operation::Report(self.employee_id));
        }
        if !self.employee_id.is_empty() {
            return Err(Error::new("TELEMETRY_REPORT_REFUSED"));
        }
        if let Some(control) = self.control {
            return self.control(control);
        }
        if self.not_after.is_some() || self.fence.is_some() {
            return Err(Error::new(
                "--not-after and --fence are only for stop-agent",
            ));
        }
        self.launch()
    }
    fn control(self, control: Control) -> Result<Operation> {
        if control == Control::StorageStatus && (self.has_launch() || self.caller_session.is_some())
        {
            return Err(Error::new(
                "Storage status accepts no identity, launch or reconciliation inputs",
            ));
        }
        if self.attach_only || self.resource_ref.is_some() {
            return Err(Error::new("Closed resource launch reference required"));
        }
        let mut request = json!({"action":control.name()});
        if matches!(control, Control::StopAgent | Control::SettleStop) {
            let session = self
                .session_id
                .filter(|sid| uuid(sid))
                .ok_or(Error::new("Invalid session identifier"))?;
            if self.caller_session.is_some() || self.cwd.is_some() || self.command.is_some() {
                return Err(Error::new(
                    "Stop control accepts only session, deadline and fence",
                ));
            }
            if control == Control::SettleStop && (self.not_after.is_some() || self.fence.is_none())
                || self.fence.is_some() && control == Control::StopAgent && self.not_after.is_none()
            {
                return Err(Error::new("Invalid stop fence/deadline combination"));
            }
            if self.fence.as_ref().is_some_and(|f| {
                f.len() != 32
                    || !f
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            }) {
                return Err(Error::new("Invalid stop fence"));
            }
            request["sessionId"] = session.into();
            if let Some(deadline) = self.not_after {
                request["notAfter"] = deadline.into();
            }
            if let Some(fence) = self.fence {
                request["fence"] = fence.into();
            }
        } else {
            if self.not_after.is_some() || self.fence.is_some() {
                return Err(Error::new(
                    "--not-after and --fence are only for stop-agent",
                ));
            }
            if let Some(caller) = self.caller_session {
                request["caller"] = caller.into();
            }
        }
        Ok(Operation::Control(request))
    }
    fn launch(self) -> Result<Operation> {
        if self.resource_ref.as_ref().is_some_and(|reference| {
            !uuid(reference) || self.attach_only || self.caller_session.is_some()
        }) {
            return Err(Error::new("Closed resource launch reference required"));
        }
        let session = self.session_id.filter(|sid| uuid(sid)).ok_or(Error::new(
            "A laptop launch requires session, directory and command",
        ))?;
        let cwd = self.cwd.filter(|cwd| !cwd.is_empty()).ok_or(Error::new(
            "A laptop launch requires session, directory and command",
        ))?;
        let command = self
            .command
            .filter(|command| !command.is_empty())
            .ok_or(Error::new(
                "A laptop launch requires session, directory and command",
            ))?;
        let mut request = json!({"sessionId":session,"cwd":cwd,"command":command});
        if self.attach_only {
            request["attachOnly"] = true.into();
        }
        Ok(Operation::Launch {
            request,
            reference: self.resource_ref,
        })
    }
}
