//! Retain existing LSM/seccomp options verbatim; only add the required nnp.
use super::*;

const NNP: &str = "no-new-privileges:true";
const INVALID: &str = "DEPLOYMENT_SECURITY_OPTIONS_UNSUPPORTED";
fn canonical(value: &str) -> &str {
    if value == "no-new-privileges" {
        NNP
    } else {
        value
    }
}
pub(super) fn protected(value: &Value) -> Result<Value> {
    let mut values = if value.is_null() {
        Vec::new()
    } else {
        value
            .as_array()
            .cloned()
            .ok_or_else(|| DeploymentError::new(INVALID))?
    };
    let mut enabled = false;
    for selected in &values {
        let selected = selected
            .as_str()
            .ok_or_else(|| DeploymentError::new(INVALID))?;
        require(selected != "no-new-privileges:false", INVALID)?;
        enabled |= canonical(selected) == NNP;
    }
    if !enabled {
        values.push(json!(NNP));
    }
    Ok(json!(values))
}
pub(in crate::model) fn normalized(value: &Value) -> Result<Value> {
    let values = value
        .as_array()
        .ok_or_else(|| DeploymentError::new(INVALID))?;
    let values = values
        .iter()
        .map(|value| {
            let value = value
                .as_str()
                .ok_or_else(|| DeploymentError::new(INVALID))?;
            Ok(json!(canonical(value)))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!(values))
}
