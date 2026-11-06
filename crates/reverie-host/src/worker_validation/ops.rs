use super::*;
use reverie_contracts::{
    storage_identity::MetadataText,
    worker_validation::{OpsBindingConfig, OpsPrivateDocument},
};
use reverie_core::posix_path::PosixPath;
#[cfg(test)]
mod tests;

pub(super) fn validate(data: &WorkerValidationData<'_>, source: &MetadataText) -> Result<()> {
    let config = OpsBindingConfig::decode(&read(source)?)?;
    if config.company_file()? != data.company_file()? {
        return Err(WorkerValidationHostError::Ops);
    }
    let roots = data.ops_exposure_roots()?;
    outside(source, &roots)?;
    for value in config.protected_paths()? {
        outside(&value, &roots)?;
    }
    if let Some(value) = config.authorization_path()? {
        outside(&value, &roots)?;
        let authorization = OpsPrivateDocument::decode(&read(&value)?)?;
        for index in 0..authorization.principal_count()? {
            outside(&authorization.principal_key(index)?, &roots)?;
        }
        let value = config.authorization_goal()?;
        outside(&value, &roots)?;
        let goal = OpsPrivateDocument::decode(&read(&value)?)?;
        for value in goal.goal_hosts()? {
            outside(&value?, &roots)?;
        }
    }
    Ok(())
}
fn outside(value: &MetadataText, roots: &[MetadataText]) -> Result<()> {
    if roots.is_empty() {
        return Err(WorkerValidationHostError::Ops);
    }
    let lexical = path(value.codepoints())?;
    let resolved = native::resolve_optional_text(value.codepoints())?;
    for value in roots {
        let mount = path(value.codepoints())?;
        if !mount.is_absolute() {
            return Err(WorkerValidationHostError::Ops);
        }
        let resolved_mount = native::resolve_optional_text(value.codepoints())?;
        // Python constructs both comparison pairs before iterating them, so
        // m.resolve() occurs even when the first lexical comparison overlaps.
        if lexical.overlaps(&mount) || resolved.overlaps(&resolved_mount) {
            return Err(WorkerValidationHostError::Ops);
        }
    }
    Ok(())
}
fn read(value: &MetadataText) -> Result<Vec<u8>> {
    let path =
        PosixPath::try_new(value.codepoints()).map_err(|_| WorkerValidationHostError::Ops)?;
    let points = path.codepoints();
    let parent = path.parent().codepoints();
    if !path.is_absolute()
        || points.iter().any(|&c| c < 32 || c == 127)
        || parent.split(|&c| c == 47).any(|p| p == [46, 46])
    {
        return Err(WorkerValidationHostError::Ops);
    }
    Ok(native::observe_ops_private(
        &native::python_path(&points)?,
        65_536,
        native::uid(),
    )?)
}
