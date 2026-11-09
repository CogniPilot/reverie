use super::*;

impl Operation {
    pub(crate) fn claim_terminal(&self, current: &Value) -> Result<&'static str> {
        require(
            !self.record_present("successor-attempt")? && !self.record_present("superseded")?,
            "DEPLOYMENT_CLAIM_HANDOVER_ALREADY_ATTEMPTED",
        )?;
        let terminal =
            if self.record_present("rollback-attempt")? || self.record_present("restored")? {
                "RESTORED"
            } else {
                "HYBRID_READY"
            };
        self.assert_claim_source(terminal, current)?;
        Ok(terminal)
    }
    pub(crate) fn assert_claim_source(&self, terminal: &str, current: &Value) -> Result<()> {
        if terminal == "HYBRID_READY" {
            require(
                !self.record_present("rollback-attempt")? && !self.record_present("restored")?,
                "DEPLOYMENT_PREDECESSOR_NOT_TERMINAL",
            )?;
            let receipt = self.read_record("ready")?;
            let candidate = self.candidate()?;
            require(
                receipt["mode"] == "hybrid-rust-front"
                    && receipt["brokerChanged"] == false
                    && receipt["containerId"] == candidate
                    && current["Id"] == candidate,
                "DEPLOYMENT_PREDECESSOR_SOURCE_CHANGED",
            )?;
            model::candidate_matches(current, &self.plan.source, &self.plan.body)
        } else {
            require(
                terminal == "RESTORED" && self.record_present("rollback-attempt")?,
                "DEPLOYMENT_PREDECESSOR_NOT_TERMINAL",
            )?;
            let receipt = self.read_record("restored")?;
            require(
                receipt["containerId"] == self.plan.source["Id"]
                    && receipt["dataRestored"] == false
                    && receipt["brokerChanged"] == false
                    && model::projection(current) == model::projection(&self.plan.source),
                "DEPLOYMENT_PREDECESSOR_SOURCE_CHANGED",
            )
        }
    }
}
