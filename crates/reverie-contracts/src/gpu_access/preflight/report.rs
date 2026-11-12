//! Complete original standalone report. All inputs remain captured DATA;
//! final finite encoding and the 64-KiB bound grant no device entitlement.
use super::*;
use crate::{
    reservation_control, worker_config::EffectiveWorkerConfig, worker_image_switch::WorkerImageId,
};
use reverie_core::{device_policy::NvidiaCdiDevice, gpu_access::PhysicalGpu};

pub struct PreflightReport<'a> {
    pub config: &'a EffectiveWorkerConfig,
    pub candidate: &'a PreflightCandidate,
    pub binding: &'a PreflightBinding,
    pub engine: &'a PreflightEngineData,
    pub device: &'a NvidiaCdiDevice,
    pub physical: &'a PhysicalGpu,
    pub cdi: &'a PreflightCdiData,
    pub image: &'a WorkerImageId,
    pub image_labels: &'a PreflightImageLabels,
    pub laptop: &'a PreflightLaptopData,
    pub resources: &'a EffectiveWorkerConfig,
    pub configured: Option<&'a NvidiaCdiDevice>,
}
pub struct PreflightReportData<'a> {
    value: Value,
    cdi: &'a PreflightCdiData,
}
impl<'a> PreflightReport<'a> {
    /// Construct the report before the final configuration read. CDI path
    /// serialization and finite JSON refusal remain after that native read.
    pub fn capture(self) -> Result<PreflightReportData<'a>> {
        let mut value = Object::from([
            (key("kind"), string("GPU_LAPTOP_METADATA_ONLY")),
            (key("employee"), self.binding.value()),
            (key("engine"), self.engine.value()?),
            (key("device"), string(self.device.as_str())),
            (key("physicalGPU"), physical(self.physical)),
            (key("image"), string(self.image.as_str())),
            (
                key("browserProfile"),
                boolean(self.image_labels.browser_profile()?),
            ),
            (
                key("ownerIntentAllowsStart"),
                boolean(self.binding.start_allowed()),
            ),
            (key("resources"), resource_fields(self.resources)?),
            (key("currentLaptop"), self.laptop.value().deep_clone()),
            (
                key("currentlyConfiguredGrant"),
                self.configured
                    .map_or(Value(Node::Null), |device| string(device.as_str())),
            ),
            (
                key("policyDomain"),
                domain(self.config, self.candidate.configuration())?,
            ),
        ]);
        for name in [
            "protectedConfigGenerationRebindRequiredIfInstalled",
            "newGrantRequiresReviewedBrokerConfigurationAndSelectedLaptopRecreation",
        ] {
            value.insert(key(name), boolean(true));
        }
        for name in [
            "nativeDeviceAccessVerified",
            "GPUComputeOrRenderingVerified",
            "VRAMQuotaEnforced",
            "effectsPerformed",
        ] {
            value.insert(key(name), boolean(false));
        }
        Ok(PreflightReportData {
            value: Value(Node::Object(value)),
            cdi: self.cdi,
        })
    }
}
impl PreflightReportData<'_> {
    pub fn encode(mut self) -> Result<Vec<u8>> {
        let Node::Object(value) = &mut self.value.0 else {
            unreachable!("captured report object");
        };
        value.insert(key("cdi"), self.cdi.value()?);
        let value = self.value;
        if !value.is_finite() {
            return Err(GpuDataError::Nonfinite);
        }
        let mut bytes = crate::worker_config::encode_data(&value);
        if bytes.len() > 65536 {
            return Err(GpuDataError::CdiDocument);
        }
        bytes.push(b'\n');
        Ok(bytes)
    }
}
fn boolean(value: bool) -> Value {
    Value(Node::Bool(value))
}
fn physical(value: &PhysicalGpu) -> Value {
    Value(Node::Object(
        [
            ("uuid", value.uuid()),
            ("pci", value.pci()),
            ("deviceMinor", value.minor()),
            ("model", value.model()),
        ]
        .into_iter()
        .map(|(name, value)| (key(name), string(value)))
        .collect(),
    ))
}
fn resource_fields(config: &EffectiveWorkerConfig) -> Result<Value> {
    let root = object(config.as_value()).ok_or(GpuDataError::Configuration)?;
    let fields = [
        "budgetMode",
        "memoryMiB",
        "pidsLimit",
        "cpus",
        "poolMemoryMiB",
        "poolTasksMax",
    ]
    .into_iter()
    .map(|name| {
        Ok((
            key(name),
            field(root, name)
                .ok_or(GpuDataError::Configuration)?
                .deep_clone(),
        ))
    })
    .collect::<Result<Object>>()?;
    Ok(Value(Node::Object(fields)))
}
fn domain(before: &EffectiveWorkerConfig, proposed: &EffectiveWorkerConfig) -> Result<Value> {
    Ok(Value(Node::Object(
        [
            (
                key("before"),
                string(&reservation_control::domain_digest(before)?.to_hex()),
            ),
            (
                key("proposed"),
                string(&reservation_control::domain_digest(proposed)?.to_hex()),
            ),
            (key("reconciliationRequiredIfProvisioned"), boolean(true)),
            (key("neverResetExistingJournal"), boolean(true)),
        ]
        .into(),
    )))
}
