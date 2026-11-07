use super::*;
use reverie_contracts::worker_source_stop::{OrdinaryContainer, ordinary_container_absent};
use std::{ffi::OsString, time::Duration};
impl StoppedLaptopRemoval {
    pub(super) fn body(
        &self,
        runtime: &WorkerRuntime,
        pending: &mut Option<CapturedCall>,
        deadline: Option<Instant>,
    ) -> Result<()> {
        let target = self
            .container
            .as_ref()
            .map_or(self.name.as_str(), ContainerId::as_str);
        let before = self.call(
            pending,
            vec!["inspect".into(), target.into()],
            false,
            deadline,
        )?;
        if !before.succeeded {
            return self.require_absent(pending, deadline);
        }
        let Some(expected) = &self.container else {
            // Absence at stop cannot mint permission to remove a newly observed
            // target which took its name while Nix preparation was running.
            return Err(SourceStopError::Refused(
                "WORKER_STOPPED_REMOVAL_IDENTITY_CHANGED",
            ));
        };
        let row = OrdinaryContainer::decode(
            &before.stdout,
            &self.name,
            runtime.worker_identity().deployment(),
            &self.session,
        )
        .map_err(SourceStopError::Data)?;
        need(
            row.id() == expected && row.stopped(),
            "WORKER_STOPPED_REMOVAL_STATE_CHANGED",
        )?;
        if let Binding::Exact(metadata) = &self.binding {
            let exact = metadata
                .observe(&before.stdout, true)
                .map_err(SourceStopError::Data)?;
            need(
                !exact.running() && exact.pid().is_zero(),
                "WORKER_STOPPED_REMOVAL_STATE_CHANGED",
            )?;
        }
        // Original post-Nix rm has NO force/volume flag. A real restart racing
        // the last observation therefore fails rather than deleting a live CID.
        self.call(
            pending,
            vec!["rm".into(), expected.as_str().into()],
            true,
            deadline,
        )?;
        self.require_absent(pending, deadline)
    }
    fn require_absent(
        &self,
        pending: &mut Option<CapturedCall>,
        deadline: Option<Instant>,
    ) -> Result<()> {
        let output = self.call(
            pending,
            [
                "ps",
                "--all",
                "--no-trunc",
                "--format",
                "{{.ID}} {{.Names}}",
            ]
            .map(Into::into)
            .to_vec(),
            true,
            deadline,
        )?;
        need(
            ordinary_container_absent(&output.stdout, &self.name, self.container.as_ref())
                .map_err(SourceStopError::Data)?,
            "WORKER_STOPPED_REMOVAL_UNCONFIRMED",
        )
    }
    fn call(
        &self,
        pending: &mut Option<CapturedCall>,
        args: Vec<OsString>,
        required: bool,
        deadline: Option<Instant>,
    ) -> Result<crate::captured_client::CapturedOutput> {
        let original = Instant::now() + Duration::from_secs(20);
        let end = deadline.map_or(original, |end| original.min(end));
        if deadline.is_none() {
            call::captured_for_worker(&self.origin, end, pending, args, required)
        } else {
            call::captured(&self.origin, end, pending, args, required)
        }
    }
}
