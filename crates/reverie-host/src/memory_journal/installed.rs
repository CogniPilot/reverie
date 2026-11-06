//! Package facts, not environment or request selectors. The raw TypeScript
//! console entry runs under the selected native Node executable, never a shell
//! wrapper or a PATH-selected Python frontend.
use super::{JournalClientError, JournalClientFault, Result};
use std::path::{Path, PathBuf};

pub(super) fn command() -> Result<(PathBuf, PathBuf)> {
    let program = fixed(option_env!("REVERIE_FIXED_JOURNAL_NODE"))?;
    let entrypoint = fixed(option_env!("REVERIE_FIXED_JOURNAL_ENTRY"))?;
    Ok((program, entrypoint))
}

fn fixed(value: Option<&str>) -> Result<PathBuf> {
    let refused = || JournalClientError::new(JournalClientFault::Bootstrap);
    let path = Path::new(value.ok_or_else(refused)?);
    if !path.is_absolute()
        || !path.starts_with("/nix/store")
        || !path.metadata().is_ok_and(|metadata| metadata.is_file())
        || !path.canonicalize().is_ok_and(|canonical| canonical == path)
    {
        return Err(refused());
    }
    Ok(path.to_owned())
}

#[cfg(test)]
mod tests {
    #[test]
    fn absent_or_noncanonical_build_facts_refuse_without_path_search() {
        for value in [
            None,
            Some("node"),
            Some("/bin/node"),
            Some("/nix/store/../node"),
        ] {
            assert!(super::fixed(value).is_err());
        }
    }
}
