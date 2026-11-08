//! Exact immutable host alias chain compared to the selected init's read-only
//! image. Returns code identity DATA, never program/peer/owner/action authority.
#[cfg(test)]
mod tests;
mod walk;
use super::{code, files::Descriptors, *};
use code::files::{check_end, nix_path};
use reverie_contracts::resource_actor::CodeFile;
use reverie_core::{PythonText, decimal::UnsignedInteger};
use std::{path::Path, time::Instant};

#[derive(Default)]
#[must_use = "retain this observer and the original actor hold after uncertain close"]
pub struct ImmutableAliasObserver {
    close_uncertain: bool,
    cache: code::cache::HashCache,
}
pub struct ObservedCodeAlias {
    canonical: PythonText,
    file: ObservedCodeFile,
}
impl ObservedCodeAlias {
    pub fn canonical_path(&self) -> &PythonText {
        &self.canonical
    }
    pub fn identity(&self) -> [u64; 2] {
        self.file.identity()
    }
}
impl ImmutableAliasObserver {
    /// Only the original observer's sticky checked-close outcome. No I/O,
    /// retry, uncertainty reset, or program/peer/owner authority is supplied.
    pub fn assert_finalized(&self) -> Result<()> {
        need(!self.close_uncertain, "INVOCATION_ALIAS_CLOSE_UNCONFIRMED")
    }
    /// Only installer-selected invocation/manifest DATA. The authenticating
    /// factory must bracket its real init/engine, check the target against the
    /// selected program, and compare actual peer argv/executable separately.
    pub fn observe_alias(
        &mut self,
        init: &UnsignedInteger,
        invocation: &PythonText,
        manifest: &[CodeFile],
        end: Instant,
    ) -> Result<ObservedCodeAlias> {
        self.assert_finalized()?;
        need(
            init.to_u64()
                .is_some_and(|pid| pid > 1 && u32::try_from(pid).is_ok()),
            "WEBSITE_INIT_SELECTION",
        )?;
        need(
            (1..=4096).contains(&manifest.len()),
            "IMMUTABLE_CODE_MANIFEST_REQUIRED",
        )?;
        let path = nix_path(invocation)?;
        let mut files = Descriptors::default();
        let body = observe(&mut files, init, &path, manifest, &self.cache, end);
        let (observed, verified) = files.finish(body, &mut self.close_uncertain)?;
        self.cache.publish(verified);
        Ok(observed)
    }
}
fn observe(
    files: &mut Descriptors,
    init: &UnsignedInteger,
    path: &Path,
    manifest: &[CodeFile],
    cache: &code::cache::HashCache,
    end: Instant,
) -> Result<(ObservedCodeAlias, code::cache::Verified)> {
    check_end(end)?;
    let expected = std::fs::canonicalize(path)?;
    let canonical = PythonText::try_new(native::python_text(&expected)).expect("OS codepoints");
    nix_path(&canonical)?;
    let actual = walk::alias(files, init, path, end)?;
    need(actual == expected, "INVOCATION_TARGET_CHANGED")?;
    let mut matches = manifest.iter().filter(|code| code.path == canonical);
    let selected = matches
        .next()
        .ok_or(WebsiteFactsError::Refused("UNMANIFESTED_BACKEND_CODE"))?;
    need(
        matches.next().is_none() && selected.bytes <= code::MAX_CODE_FILE,
        "IMMUTABLE_CODE_BINDING",
    )?;
    let (file, verified) = code::observe(files, init, &actual, selected, cache, end)?;
    Ok((ObservedCodeAlias { canonical, file }, verified))
}
