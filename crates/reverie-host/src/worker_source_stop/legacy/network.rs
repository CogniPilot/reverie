use super::*;
use reverie_contracts::worker_source_stop::{OrdinaryNetwork, ordinary_network_absent};
impl OrdinaryStopAttempt {
    pub(super) fn cleanup_network(&mut self, runtime: &WorkerRuntime) -> Result<()> {
        let name = format!("{}-lan", self.name);
        let result = self.call(
            vec!["network".into(), "inspect".into(), name.clone().into()],
            false,
        )?;
        if !result.succeeded {
            return self.require_network_absent(&name, None);
        }
        let network = OrdinaryNetwork::decode(
            &result.stdout,
            &name,
            runtime.worker_identity().deployment(),
            &self.session,
        )
        .map_err(SourceStopError::Data)?;
        let Some(network) = network else {
            return Ok(());
        };
        if let Some(cid) = &self.container {
            self.call(
                vec![
                    "network".into(),
                    "disconnect".into(),
                    "--force".into(),
                    network.id().into(),
                    cid.as_str().into(),
                ],
                false,
            )?;
        }
        self.call(
            vec!["network".into(), "rm".into(), network.id().into()],
            false,
        )?;
        let after = self.call(
            vec!["network".into(), "inspect".into(), network.id().into()],
            false,
        )?;
        // A present or ambiguous network never becomes successful cleanup.
        // Its original immutable ID cannot retarget a same-name replacement.
        need(!after.succeeded, "WORKER_ORDINARY_STOP_NETWORK_RETAINED")?;
        self.require_network_absent(network.name(), Some(network.id()))
    }
    fn require_network_absent(&mut self, name: &str, id: Option<&str>) -> Result<()> {
        let output = self.call(
            vec![
                "network".into(),
                "ls".into(),
                "--no-trunc".into(),
                "--format".into(),
                "{{.ID}} {{.Name}}".into(),
            ],
            true,
        )?;
        let absent =
            ordinary_network_absent(&output.stdout, name, id).map_err(SourceStopError::Data)?;
        need(absent, "WORKER_ORDINARY_STOP_NETWORK_UNAVAILABLE")
    }
}
