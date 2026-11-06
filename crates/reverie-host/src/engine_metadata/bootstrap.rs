use super::{EngineError, EngineFault, Result};
use crate::captured_client::InstalledCommand;
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    path::PathBuf,
};
/// Installing-service configuration, never request data. The shared command
/// snapshot freezes cwd/environment; EngineQuery still owns the only argv.
pub struct EngineBootstrap {
    command: InstalledCommand,
    #[cfg(test)]
    pub(crate) hooks: super::tests::Hooks,
}
impl EngineBootstrap {
    pub fn capture(program: &OsStr) -> Result<Self> {
        Self::from_service(
            program,
            std::env::vars_os().collect(),
            std::env::current_dir().map_err(|_| invalid())?,
        )
    }
    pub fn from_service(
        program: &OsStr,
        environment: BTreeMap<OsString, OsString>,
        directory: PathBuf,
    ) -> Result<Self> {
        let command =
            InstalledCommand::from_service(program, environment, directory).ok_or_else(invalid)?;
        Ok(Self {
            command,
            #[cfg(test)]
            hooks: super::tests::Hooks::default(),
        })
    }
    pub(super) fn into_command(self) -> InstalledCommand {
        let command = self.command;
        #[cfg(test)]
        let command = {
            let mut command = command;
            command.hooks = self.hooks;
            command
        };
        command
    }
}
fn invalid() -> EngineError {
    EngineError::new(EngineFault::Bootstrap)
}
