use super::{LaunchRuleError, valid_text};
use crate::posix_path::PosixPath;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerDirectory {
    original: Vec<u32>,
    lexical: PosixPath,
}
impl WorkerDirectory {
    pub fn try_new(original: Vec<u32>) -> Result<Self, LaunchRuleError> {
        let lexical = PosixPath::try_new(&original).map_err(|_| LaunchRuleError::Directory)?;
        if !valid_text(&original) || !lexical.is_absolute() || lexical.has_parent_component() {
            return Err(LaunchRuleError::Directory);
        }
        Ok(Self { original, lexical })
    }
    pub fn require_writable<'a>(
        &self,
        roots: impl IntoIterator<Item = &'a PosixPath>,
    ) -> Result<(), LaunchRuleError> {
        if roots
            .into_iter()
            .any(|root| self.lexical.is_relative_to(root))
        {
            Ok(())
        } else {
            Err(LaunchRuleError::OutsideGrants)
        }
    }
    pub fn codepoints(&self) -> &[u32] {
        &self.original
    }
}

/// Only account namespace lexical selection. Native resolution/containment is
/// an additional, fresh readonly observation before preparing a mount string.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountSelection {
    destination: Vec<u32>,
    relative: PosixPath,
}
impl AccountSelection {
    pub fn try_new(destination: Vec<u32>) -> Result<Self, LaunchRuleError> {
        let path = PosixPath::try_new(&destination).map_err(|_| LaunchRuleError::Account)?;
        let root = PosixPath::from_scalar_text("/instances/default");
        let relative = path.relative_to(&root).ok_or(LaunchRuleError::Account)?;
        let account = PosixPath::from_scalar_text("accounts");
        let console = PosixPath::from_scalar_text("console/accounts");
        if !valid_text(&destination)
            || path.has_parent_component()
            || !((relative.is_relative_to(&account) && relative != account)
                || (relative.is_relative_to(&console) && relative != console))
        {
            return Err(LaunchRuleError::Account);
        }
        Ok(Self {
            destination,
            relative,
        })
    }
    pub fn destination(&self) -> &[u32] {
        &self.destination
    }
    pub fn relative(&self) -> &PosixPath {
        &self.relative
    }
}
