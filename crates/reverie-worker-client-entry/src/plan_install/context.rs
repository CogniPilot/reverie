use super::files::{Files, Identity};
use super::input::{Context, Role, Source, decimal};
use super::{Failure, Result, need};
use nix::unistd::geteuid;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
const HISTORY_LIMIT: u64 = 512 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RoleReadback {
    pub(super) role: Role,
    pub(super) dev: String,
    pub(super) ino: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ContextReadback {
    pub(super) roles: Vec<RoleReadback>,
    pub(super) conversation_digest: Option<String>,
}
fn identity(value: Identity, role: Role) -> RoleReadback {
    RoleReadback {
        role,
        dev: value.dev.to_string(),
        ino: value.ino.to_string(),
    }
}
fn source(
    files: &mut Files,
    home: usize,
    value: &Source,
) -> Result<Option<(usize, Option<PathBuf>)>> {
    let (root, expected_dev, expected_ino, path) = match value {
        Source::None => return Ok(None),
        Source::Home { relative, dev, ino } => {
            let mut id = home;
            let mut path = PathBuf::from("/home/agent");
            for name in relative {
                id = files.child(id, name, false, false)?;
                path.push(name);
            }
            (id, dev, ino, Some(path))
        }
        Source::Intake { dev, ino } => {
            let id = files.root(
                Path::new("/run/reverie-plan-context"),
                geteuid().as_raw(),
                false,
            )?;
            let flags = nix::sys::statvfs::fstatvfs(files.file(id)?)
                .map_err(|e| Failure::new("intake-mount", e))?
                .flags();
            need(
                flags.contains(nix::sys::statvfs::FsFlags::ST_RDONLY),
                "intake-readonly",
            )?;
            (id, dev, ino, None)
        }
    };
    let actual = files.identity(root)?;
    need(
        actual.dev == decimal(expected_dev, false)? && actual.ino == decimal(expected_ino, true)?,
        "context-source-identity",
    )?;
    Ok(Some((root, path)))
}
fn selected_file(files: &mut Files, root: usize, relative: &[String]) -> Result<(usize, String)> {
    let (name, parents) = relative
        .split_last()
        .ok_or_else(|| Failure::refused("context-file"))?;
    let mut parent = root;
    for part in parents {
        parent = files.child(parent, part, false, false)?;
    }
    Ok((parent, name.clone()))
}
pub(super) fn install(
    files: &mut Files,
    home: usize,
    target: usize,
    value: &Context,
) -> Result<ContextReadback> {
    let Some((root, path)) = source(files, home, &value.source)? else {
        return Ok(ContextReadback {
            roles: vec![],
            conversation_digest: None,
        });
    };
    let mut roles = vec![];
    if let Some(path) = path {
        for role in &value.roles {
            let name = role.filename();
            let observed = if role.is_directory() {
                let id = files.child(root, name, false, false)?;
                files.identity(id)?
            } else {
                files.read(root, name, 1024 * 1024, false)?;
                files.file_identity(root, name)?
            };
            files.link(target, name, &path.join(name))?;
            roles.push(identity(observed, *role));
        }
    } else {
        let conversation = value
            .conversation
            .as_ref()
            .ok_or_else(|| Failure::refused("intake-selected-conversation"))?;
        let (parent, name) = selected_file(files, root, &conversation.relative)?;
        let mut output = target;
        for name in &conversation.relative[..conversation.relative.len() - 1] {
            output = files.child(output, name, true, true)?;
        }
        let mut remaining = HISTORY_LIMIT;
        let copied = files.copy_file(parent, output, &name, &mut remaining)?;
        need(copied == conversation.sha256, "intake-conversation-bytes")?;
        let role = value.roles[0];
        let role_root = files.child(target, role.filename(), false, true)?;
        roles.push(identity(files.identity(role_root)?, role));
    }
    let conversation_digest = if let Some(conversation) = &value.conversation {
        let (parent, name) = selected_file(files, root, &conversation.relative)?;
        let actual = files.hash_file(parent, &name, HISTORY_LIMIT)?;
        need(
            actual == conversation.sha256,
            "source-conversation-currency",
        )?;
        Some(actual)
    } else {
        None
    };
    files.current()?;
    Ok(ContextReadback {
        roles,
        conversation_digest,
    })
}
pub(super) fn verify(
    files: &mut Files,
    home: usize,
    target: usize,
    value: &Context,
    readback: &ContextReadback,
    initial: bool,
) -> Result<ContextReadback> {
    let selected = match &value.source {
        Source::Intake { .. } if !initial => Some((target, None)),
        _ => source(files, home, &value.source)?,
    };
    let Some((root, path)) = selected else {
        need(
            readback.roles.is_empty() && readback.conversation_digest.is_none(),
            "context-empty",
        )?;
        return Ok(ContextReadback {
            roles: vec![],
            conversation_digest: None,
        });
    };
    need(
        readback.roles.len() == value.roles.len(),
        "context-role-count",
    )?;
    need(
        readback.conversation_digest.as_ref() == value.conversation.as_ref().map(|v| &v.sha256),
        "context-historical-conversation",
    )?;
    let mut observed = vec![];
    for (role, expected) in value.roles.iter().zip(&readback.roles) {
        need(*role == expected.role, "context-role")?;
        let actual = if let Some(path) = &path {
            files.link_matches(target, role.filename(), &path.join(role.filename()))?;
            if role.is_directory() {
                let id = files.child(root, role.filename(), false, false)?;
                files.identity(id)?
            } else {
                files.read(root, role.filename(), 1024 * 1024, false)?;
                files.file_identity(root, role.filename())?
            }
        } else {
            let id = files.child(target, role.filename(), false, true)?;
            files.identity(id)?
        };
        need(
            (!initial && !role.is_directory())
                || (actual.dev.to_string() == expected.dev
                    && actual.ino.to_string() == expected.ino),
            "context-role-identity",
        )?;
        observed.push(identity(actual, *role));
    }
    if initial && let Some(conversation) = &value.conversation {
        let selected = if path.is_some() { root } else { target };
        let (parent, name) = selected_file(files, selected, &conversation.relative)?;
        need(
            files.hash_file(parent, &name, HISTORY_LIMIT)? == conversation.sha256
                && readback.conversation_digest.as_deref() == Some(&conversation.sha256),
            "context-conversation-readback",
        )?;
    }
    files.current()?;
    Ok(ContextReadback {
        roles: observed,
        conversation_digest: if initial {
            readback.conversation_digest.clone()
        } else {
            None
        },
    })
}
