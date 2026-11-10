//! Preserved negative installation DATA. Matching it is never activation,
//! cleanup acknowledgement, maintenance consent or permission to replay.
use super::*;
use crate::{resource_actor::PoolInstallationRequestData, worker_recovery::RecoveryInspection};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Receipt {
    version: u32,
    purpose: String,
    original_request_digest: String,
    container_id: String,
    retired_name: String,
    birth_digest: String,
    #[serde(rename = "originalInspectionSHA256")]
    original_inspection_sha256: String,
    #[serde(rename = "stdoutSHA256")]
    stdout_sha256: String,
    #[serde(rename = "stderrSHA256")]
    stderr_sha256: String,
    original_inspection_bytes: Vec<u8>,
    container_stdout: Vec<u8>,
    container_stderr: Vec<u8>,
    original_activation_completed: bool,
    resume_authorized: bool,
    workers_started: bool,
}
pub struct RetiredControllerData(Receipt);
impl RetiredControllerData {
    pub fn decode(raw: &[u8]) -> Result<Self, PoolPolicyError> {
        if raw.is_empty() || raw.len() > 65_536 {
            return Err(PoolPolicyError);
        }
        // Check duplicate object keys before the schema decoder, including
        // nested data. Integer byte arrays then reject nonfinite/noninteger data.
        crate::worker_config::decode(raw).map_err(|_| PoolPolicyError)?;
        let value: Receipt = serde_json::from_slice(raw).map_err(|_| PoolPolicyError)?;
        if value.version != 1
            || value.purpose != "reverie-failed-pool-installation-retired-negative-v1"
            || value.original_activation_completed
            || value.resume_authorized
            || value.workers_started
            || !hex_id(&value.container_id)
            || !hex_id(&value.birth_digest)
            || !hex_id(&value.original_request_digest)
            || !value.container_stdout.is_empty()
            || !matches!(
                value.container_stderr.as_slice(),
                b"WORKER_POOL_ENGINE_ROOT_PEER_REQUIRED\nWORKER_POOL_CLOSE_UNKNOWN\n"
                    | b"WORKER_POOL_WEBSITE_CHANGED\n"
            )
            || hash(&value.original_inspection_bytes) != value.original_inspection_sha256
            || hash(&value.container_stdout) != value.stdout_sha256
            || hash(&value.container_stderr) != value.stderr_sha256
        {
            return Err(PoolPolicyError);
        }
        Ok(Self(value))
    }
    pub fn birth_digest(&self) -> &str {
        &self.0.birth_digest
    }
    pub fn bind(
        &self,
        request_raw: &[u8],
        birth_raw: &[u8],
        current: &WorkerPoolPolicy,
        container: &str,
        retired_name: &str,
        inspection: &[u8],
    ) -> Result<ControllerBirthV2, PoolPolicyError> {
        let receipt = &self.0;
        let request =
            PoolInstallationRequestData::decode(request_raw).map_err(|_| PoolPolicyError)?;
        let birth = ControllerBirthV2::decode(birth_raw)?;
        if receipt.container_id != container
            || receipt.retired_name != retired_name
            || receipt.original_request_digest != request.digest().as_str()
            || request.canonical_bytes() != request_raw
            || hash(birth_raw) != receipt.birth_digest
            || birth.encode()? != birth_raw
            || birth.policy() != request.policy()
        {
            return Err(PoolPolicyError);
        }
        // Historical images and soft thresholds are preserved, not selected
        // into the new proposal. Every other instance/engine/website/UID/CPU
        // binding must still match this exact installation.
        let mut scope = birth.policy().clone();
        scope.controller_image = current.controller_image.clone();
        scope.employee_memory_high_mi_b = current.employee_memory_high_mi_b.clone();
        if scope != *current {
            return Err(PoolPolicyError);
        }
        validate_failed_controller_service_v2_inspection(
            inspection,
            birth.policy(),
            container,
            &receipt.birth_digest,
            retired_name,
        )?;
        let old_name = birth.policy().controller_name();
        if !RecoveryInspection::same_renamed_container_object_inspection(
            container,
            &receipt.original_inspection_bytes,
            inspection,
            &old_name,
            retired_name,
        )
        .map_err(|_| PoolPolicyError)?
        {
            return Err(PoolPolicyError);
        }
        Ok(birth)
    }
}
fn hash(raw: &[u8]) -> String {
    format!("{:x}", Sha256::digest(raw))
}
