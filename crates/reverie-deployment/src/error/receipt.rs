use super::diagnostic::{MAX_DEPTH, MAX_NODES};
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    schema: String,
    operation: String,
    phase: String,
    data: Diagnostic,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Diagnostic {
    version: u8,
    error: ErrorNode,
    truncated: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ErrorNode {
    code: String,
    snapshot: Option<SnapshotNode>,
    finalization: Vec<ErrorNode>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SnapshotNode {
    code: String,
    secondary: Vec<SnapshotNode>,
}

const INVALID: &str = "DEPLOYMENT_DIAGNOSTIC_INVALID";
pub(crate) fn decode_receipt(bytes: &[u8], operation: &str) -> Result<serde_json::Value> {
    let receipt: Receipt =
        serde_json::from_slice(bytes).map_err(|_| DeploymentError::new(INVALID))?;
    super::super::require(
        receipt.schema == "reverie-console-deployment-receipt-v1"
            && receipt.operation == operation
            && receipt.phase == "snapshot-refused"
            && receipt.data.version == 1,
        INVALID,
    )?;
    let mut remaining = MAX_NODES;
    receipt.data.error.validate(0, &mut remaining)?;
    serde_json::to_value(receipt.data).map_err(Into::into)
}
fn enter(code: &str, depth: usize, remaining: &mut usize) -> Result<()> {
    super::super::require(
        *remaining > 0
            && depth < MAX_DEPTH
            && code.len() <= 96
            && (code.starts_with("DEPLOYMENT_") || code.starts_with("SNAPSHOT_"))
            && code
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'),
        INVALID,
    )?;
    *remaining -= 1;
    Ok(())
}
impl ErrorNode {
    fn validate(&self, depth: usize, remaining: &mut usize) -> Result<()> {
        enter(&self.code, depth, remaining)?;
        if let Some(snapshot) = &self.snapshot {
            snapshot.validate(depth + 1, remaining)?;
        }
        for error in &self.finalization {
            error.validate(depth + 1, remaining)?;
        }
        Ok(())
    }
}
impl SnapshotNode {
    fn validate(&self, depth: usize, remaining: &mut usize) -> Result<()> {
        enter(&self.code, depth, remaining)?;
        for error in &self.secondary {
            error.validate(depth + 1, remaining)?;
        }
        Ok(())
    }
}
