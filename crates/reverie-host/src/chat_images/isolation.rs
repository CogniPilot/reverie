use super::*;
use reverie_contracts::{chat_images::ImageMount, worker_schema::WorkerEnvelope};
use std::fs;
fn path(text: Option<reverie_contracts::storage_identity::MetadataText>) -> Result<PathBuf> {
    let text = text.ok_or(ImageObserveError::Refused("isolation_unverified"))?;
    crate::native::python_path(text.codepoints()).map_err(ImageObserveError::Io)
}
pub(super) fn attachments(config: &WorkerEnvelope, mounts: &[ImageMount]) -> Result<()> {
    let grants = config
        .mounts()
        .iter()
        .filter(|mount| {
            mount.destination().codepoints()
                == "/reverie_workspace"
                    .bytes()
                    .map(u32::from)
                    .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    need(grants.len() == 1, "isolation_unverified")?;
    let workspace = fs::canonicalize(
        crate::native::python_path(grants[0].source().codepoints())
            .map_err(ImageObserveError::Io)?,
    )
    .map_err(ImageObserveError::Io)?;
    let attachment = workspace.join("attachments");
    let info = fs::symlink_metadata(&attachment).map_err(ImageObserveError::Io)?;
    need(
        !info.file_type().is_symlink() && attachment.is_dir(),
        "isolation_unverified",
    )?;
    let mut masks = Vec::new();
    for mount in mounts.iter().filter(|mount| mount.kind_is("bind")) {
        let source = fs::canonicalize(path(mount.source())?).map_err(ImageObserveError::Io)?;
        let destination = path(mount.destination())?;
        if source == workspace {
            need(
                destination == Path::new("/reverie_workspace")
                    || destination == Path::new("/workspace"),
                "isolation_unverified",
            )?;
            masks.push(destination.join("attachments"));
        } else {
            need(
                !source.starts_with(&attachment) && !attachment.starts_with(&source),
                "isolation_unverified",
            )?;
        }
    }
    need(
        masks.contains(&PathBuf::from("/reverie_workspace/attachments")),
        "isolation_unverified",
    )?;
    for target in masks {
        let exact = mounts
            .iter()
            .filter(|mount| path(mount.destination()).is_ok_and(|path| path == target))
            .collect::<Vec<_>>();
        need(
            exact.len() == 1 && exact[0].kind_is("tmpfs") && exact[0].read_write_is(false),
            "isolation_unverified",
        )?;
        no_shadow(mounts, &target, "isolation_unverified")?;
    }
    Ok(())
}
fn no_shadow(mounts: &[ImageMount], target: &Path, code: &'static str) -> Result<()> {
    for mount in mounts {
        let destination =
            path(mount.destination()).map_err(|_| ImageObserveError::Refused(code))?;
        need(
            destination == target || !destination.starts_with(target),
            code,
        )?;
    }
    Ok(())
}
pub(super) fn storage(mounts: &[ImageMount], root: &Path, temporary: &Path) -> Result<()> {
    let root = fs::canonicalize(root).map_err(ImageObserveError::Io)?;
    for mount in mounts.iter().filter(|mount| mount.kind_is("bind")) {
        let source = fs::canonicalize(path(mount.source())?).map_err(ImageObserveError::Io)?;
        let ledger = source.parent() == Some(root.as_path())
            && source
                .file_name()
                .is_some_and(|name| name.as_encoded_bytes().starts_with(b".chat-image-custody"));
        need(!root.starts_with(&source) && !ledger, "custody_exposed")?;
    }
    let exact = mounts
        .iter()
        .filter(|mount| path(mount.destination()).is_ok_and(|path| path == Path::new("/tmp")))
        .collect::<Vec<_>>();
    need(
        exact.len() == 1
            && exact[0].kind_is("bind")
            && exact[0]
                .source()
                .is_some_and(|source| source.codepoints() == crate::native::python_text(temporary))
            && exact[0].read_write_is(true),
        "scratch_unverified",
    )?;
    no_shadow(mounts, Path::new("/tmp"), "scratch_unverified")
}
