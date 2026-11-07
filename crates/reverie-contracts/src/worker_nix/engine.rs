//! Purpose-specific engine stdout DATA. A decoded row does not authorize rm,
//! start, helper adoption or any other engine mutation.
use super::*;
use crate::legacy_json::{self, Number, truthy};
use reverie_core::ids::{ContainerId, ProfileSessionId};

fn first(raw: &[u8]) -> Result<Value> {
    let mut value = legacy_json::decode_python_str(raw).map_err(|_| NixDataError::Json)?;
    let Node::Array(rows) = &mut value.0 else {
        return Err(NixDataError::Image);
    };
    if rows.is_empty() {
        return Err(NixDataError::Image);
    }
    Ok(std::mem::replace(&mut rows[0], Value(Node::Null)))
}
fn required_object(value: Option<&Value>) -> Result<&Object> {
    value.and_then(object).ok_or(NixDataError::Image)
}
fn equal_text(value: Option<&Value>, expected: &MetadataText) -> bool {
    matches!(value,Some(Value(Node::String(value))) if value.0==expected.codepoints())
}
/// Literal string1 only; absent/falsy labels preserve legacy image opt-out.
pub fn image_supports_private_store(raw: &[u8]) -> Result<bool> {
    let image = first(raw)?;
    let image = object(&image).ok_or(NixDataError::Image)?;
    let config = required_object(field(image, "Config"))?;
    let labels = field(config, "Labels");
    if !truthy(labels) {
        return Ok(false);
    }
    let labels = required_object(labels)?;
    Ok(equal_text(
        field(labels, "reverie.worker.nix-store"),
        &MetadataText::from_scalar_text("1"),
    ))
}
/// Source helper ownership projection from the fixed installed-engine inspect.
/// The service still owns the actual query origin and all effect decisions.
pub struct NixPreviousHelper {
    identity: ContainerId,
}
impl NixPreviousHelper {
    pub fn capture(
        raw: &[u8],
        deployment: &MetadataText,
        session: &ProfileSessionId,
    ) -> Result<Self> {
        let image = first(raw)?;
        let image = object(&image).ok_or(NixDataError::PreviousHelper)?;
        let config =
            required_object(field(image, "Config")).map_err(|_| NixDataError::PreviousHelper)?;
        let labels = field(config, "Labels").ok_or(NixDataError::PreviousHelper)?;
        let labels = required_object(Some(labels)).map_err(|_| NixDataError::PreviousHelper)?;
        if !equal_text(field(labels, "reverie.nix-prepare"), deployment)
            || !equal_text(
                field(labels, "reverie.session"),
                &MetadataText::from_scalar_text(session.as_str()),
            )
        {
            return Err(NixDataError::PreviousHelper);
        }
        let state =
            required_object(field(image, "State")).map_err(|_| NixDataError::PreviousHelper)?;
        let running = field(state, "Running").ok_or(NixDataError::PreviousHelper)?;
        if truthy(Some(running)) {
            return Err(NixDataError::PreviousRunning);
        }
        let identity = string(field(image, "Id")).map_err(|_| NixDataError::PreviousHelper)?;
        let identity = identity.scalar_text().ok_or(NixDataError::Container)?;
        Ok(Self {
            identity: ContainerId::parse(&identity).map_err(|_| NixDataError::Container)?,
        })
    }
    pub fn identity(&self) -> &ContainerId {
        &self.identity
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NixHelperState {
    Running,
    Succeeded,
    Failed,
}
pub fn helper_state(raw: &[u8]) -> Result<NixHelperState> {
    let image = first(raw)?;
    let image = object(&image).ok_or(NixDataError::HelperState)?;
    let state = required_object(field(image, "State")).map_err(|_| NixDataError::HelperState)?;
    let running = field(state, "Running").ok_or(NixDataError::HelperState)?;
    if truthy(Some(running)) {
        return Ok(NixHelperState::Running);
    }
    let exit = field(state, "ExitCode").ok_or(NixDataError::HelperState)?;
    Ok(
        if exit.python_eq(&Value(Node::Number(Number::Integer("0".into())))) {
            NixHelperState::Succeeded
        } else {
            NixHelperState::Failed
        },
    )
}
pub fn created_identity(stdout: &str) -> Result<ContainerId> {
    let text = reverie_core::PythonText::from_scalar_text(stdout);
    let trimmed = text.as_text_ref().trimmed();
    let scalar: Option<String> = trimmed
        .codepoints()
        .iter()
        .map(|&v| char::from_u32(v))
        .collect();
    ContainerId::parse(&scalar.ok_or(NixDataError::Container)?).map_err(|_| NixDataError::Container)
}
/// Source's final16384 Python characters, not an arbitrary UTF-8 byte slice.
pub fn diagnostics_tail(stdout: &str, stderr: &str) -> String {
    let mut suffix = stderr.chars().rev().take(16384).collect::<Vec<_>>();
    suffix.extend(stdout.chars().rev().take(16384 - suffix.len()));
    suffix.into_iter().rev().collect()
}
