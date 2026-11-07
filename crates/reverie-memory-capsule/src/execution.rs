//! Closed memory/MCP/journal purpose, not a general Console runtime bundle.
//! Complete assets remain present; only measured production roots execute.
use crate::{Result, refused};
use std::path::Path;

pub(crate) const NODE_PTY: &str = "node_modules/node-pty/build/Release/pty.node";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Role {
    RequiredNodeAddon,
    DevelopmentBuild,
    DevelopmentRendering,
    DevelopmentBrowser,
}
impl Role {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::RequiredNodeAddon => "relocated-required-node-addon",
            Self::DevelopmentBuild => "preserved-unselected-development-build-elf",
            Self::DevelopmentRendering => "preserved-unselected-development-rendering-elf",
            Self::DevelopmentBrowser => "preserved-unselected-development-browser-or-bare-elf",
        }
    }
}

pub(crate) fn classify(path: &Path, machine: u16, architecture: u16) -> Result<Role> {
    if path == Path::new(NODE_PTY) {
        return if machine == architecture {
            Ok(Role::RequiredNodeAddon)
        } else {
            Err(refused(
                "required node-pty addon architecture differs from Node",
            ))
        };
    }
    let text = path
        .to_str()
        .ok_or_else(|| refused("module ELF path must be UTF-8"))?;
    // Last package component covers installed nested copies without treating
    // every package under an unrelated dev package as implicitly inert.
    let tail = text
        .rsplit_once("node_modules/")
        .map(|(_, tail)| tail)
        .ok_or_else(|| refused("unclassified module ELF outside node_modules"))?;
    let parts = tail.split('/').collect::<Vec<_>>();
    let package = parts
        .iter()
        .take(if tail.starts_with('@') { 2 } else { 1 })
        .copied()
        .collect::<Vec<_>>()
        .join("/");
    match package.as_str() {
        "@remotion/compositor-linux-x64-gnu" | "@remotion/compositor-linux-x64-musl" => {
            Ok(Role::DevelopmentRendering)
        }
        "esbuild"
        | "@esbuild/linux-x64"
        | "lightningcss-linux-x64-gnu"
        | "lightningcss-linux-x64-musl"
        | "@rspack/binding-linux-x64-gnu"
        | "@rspack/binding-linux-x64-musl"
        | "@rollup/rollup-linux-x64-gnu"
        | "@rollup/rollup-linux-x64-musl"
        | "@rolldown/binding-linux-x64-gnu"
        | "@rolldown/binding-linux-x64-musl" => Ok(Role::DevelopmentBuild),
        "agent-browser" | "bare-fs" | "bare-os" | "bare-url" => Ok(Role::DevelopmentBrowser),
        _ => Err(refused(&format!("unclassified module ELF: {text}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_qualified_console_elf_assets_have_explicit_execution_provenance() {
        let value: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/qualified-console-elfs.json"
        ))
        .unwrap();
        let cases = value["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 66);
        let mut required = 0;
        for case in cases {
            let role = classify(
                Path::new(case["path"].as_str().unwrap()),
                case["machine"].as_u64().unwrap().try_into().unwrap(),
                62,
            )
            .unwrap();
            assert_eq!(role.label(), case["role"].as_str().unwrap(), "{case}");
            if role == Role::RequiredNodeAddon {
                required += 1;
            }
        }
        assert_eq!(required, 1);
    }
    #[test]
    fn closed_roots_refuse_unknown_or_wrong_architecture_without_dropping_assets() {
        assert_eq!(
            classify(Path::new(NODE_PTY), 62, 62).unwrap(),
            Role::RequiredNodeAddon
        );
        assert!(classify(Path::new(NODE_PTY), 183, 62).is_err());
        assert!(classify(Path::new("node_modules/new-runtime/addon.node"), 62, 62).is_err());
        assert!(
            classify(
                Path::new("node_modules/@esbuild-unrelated/addon.node"),
                62,
                62
            )
            .is_err()
        );
        assert_eq!(classify(Path::new("node_modules/@remotion/renderer/node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg"), 62, 62).unwrap(), Role::DevelopmentRendering);
        assert_eq!(
            classify(
                Path::new("node_modules/tsx/node_modules/@esbuild/linux-x64/bin/esbuild"),
                62,
                62
            )
            .unwrap(),
            Role::DevelopmentBuild
        );
        assert_eq!(
            classify(
                Path::new("node_modules/bare-url/prebuilds/android-arm64/bare-url.bare"),
                183,
                62
            )
            .unwrap(),
            Role::DevelopmentBrowser
        );
    }
}
