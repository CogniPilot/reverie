//! Preserve original completed-client data in this private synthetic tenant.
//! Reading diagnostics never settles, retries or releases an unknown owner.
use super::*;

impl Attempt {
    pub(in crate::installing_broker::service::tests::native_cold) fn preserve_create_diagnostics(
        &self,
    ) -> Result<()> {
        let Some(service) = &self.service else {
            return Ok(());
        };
        let diagnostics = service
            .completed_create_diagnostics()
            .map_err(|error| error.to_string())?;
        for (index, diagnostic) in diagnostics.iter().enumerate() {
            let name = self.tenant.name();
            require(
                diagnostic
                    .arguments()
                    .windows(2)
                    .any(|pair| pair[0] == "--name" && pair[1] == name.as_str()),
                "original diagnostic must name this synthetic worker",
            )?;
            let arguments = diagnostic
                .arguments()
                .iter()
                .map(|argument| argument.as_encoded_bytes())
                .collect::<Vec<_>>();
            let raw = serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "kind": "original-completed-create-client-data",
                "succeeded": diagnostic.succeeded(),
                "shellCode": diagnostic.shell_code(),
                "argumentsBytes": arguments,
                "stdoutBytes": diagnostic.stdout(),
                "stderrBytes": diagnostic.stderr(),
                "settlementAuthority": false
            }))
            .map_err(|error| error.to_string())?;
            tenant::write(
                &self
                    .tenant
                    .root
                    .join(format!("create-diagnostic-{index}.json")),
                &raw,
            )?;
        }
        Ok(())
    }
}
