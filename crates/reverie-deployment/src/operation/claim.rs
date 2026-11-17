use super::*;

impl Operation {
    pub(crate) fn stale_ready(&self, own_pending: bool) -> Result<()> {
        self.prepared()?;
        for name in [
            "rollback-attempt",
            "restored",
            "superseded",
            "invalid-create-refused",
        ] {
            require(
                !self.record_present(name)?,
                "DEPLOYMENT_PREDECESSOR_NOT_TERMINAL",
            )?;
        }
        require(
            own_pending || !self.record_present("successor-attempt")?,
            "DEPLOYMENT_CLAIM_HANDOVER_ALREADY_ATTEMPTED",
        )?;
        let ready = self.read_record("ready")?;
        require(
            ready["mode"] == "hybrid-rust-front"
                && ready["brokerChanged"] == false
                && ready["containerId"] == self.candidate()?,
            "DEPLOYMENT_PREDECESSOR_NOT_TERMINAL",
        )
    }
    pub(crate) fn claim_terminal(&self, current: &Value) -> Result<&'static str> {
        require(
            !self.record_present("successor-attempt")? && !self.record_present("superseded")?,
            "DEPLOYMENT_CLAIM_HANDOVER_ALREADY_ATTEMPTED",
        )?;
        let terminal = if self.record_present("invalid-create-refused")? {
            "INVALID_CREATE_REFUSED"
        } else if self.record_present("rollback-attempt")? || self.record_present("restored")? {
            "RESTORED"
        } else {
            "HYBRID_READY"
        };
        self.assert_claim_source(terminal, current)?;
        Ok(terminal)
    }
    pub(crate) fn assert_claim_source(&self, terminal: &str, current: &Value) -> Result<()> {
        if terminal == "INVALID_CREATE_REFUSED" {
            return self.assert_invalid_create_refused(current);
        }
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
            self.plan.candidate_matches(current)
        } else {
            require(
                terminal == "RESTORED" && self.record_present("rollback-attempt")?,
                "DEPLOYMENT_PREDECESSOR_NOT_TERMINAL",
            )?;
            let receipt = self.read_record("restored")?;
            self.plan.source_matches(current)?;
            require(
                receipt["containerId"] == self.plan.source["Id"]
                    && receipt["dataRestored"] == false
                    && receipt["brokerChanged"] == false,
                "DEPLOYMENT_PREDECESSOR_SOURCE_CHANGED",
            )
        }
    }
}
