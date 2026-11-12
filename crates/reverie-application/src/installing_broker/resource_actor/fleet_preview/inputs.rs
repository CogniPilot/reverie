//! The one compiler-selected package input, read by the SAME Frame observer.
//! Observed bytes are retained before decoding; this is not another native
//! input owner or an authority constructor from supplied artifact references.
use super::*;
use reverie_host::{
    website_facts::{ImmutableInputKind, ObservedImmutableInput, WebsiteFactsError},
    worker_pool::compiled_pool_image_inputs_reference,
};

pub(super) struct PoolInputs {
    reference: ArtifactReference,
    raw: ObservedImmutableInput,
    document: Option<PoolImageInputsData>,
}
fn fixed_reference() -> Result<ArtifactReference> {
    compiled_pool_image_inputs_reference()
        .map_err(WebsiteFactsError::from)
        .map_err(ResourceActorError::from)?
        .ok_or(Cause::Refused("FLEET_PREVIEW_FIXED_POOL_INPUTS_REQUIRED"))
}
impl NativeFleetPreview<'_> {
    pub(super) fn original_end(&self) -> Instant {
        let frame = self.frame.as_ref().expect("same original Q");
        frame
            .broker
            .storage
            .runtime
            .stop_deadline()
            .map_or(frame.deadline, |end| frame.deadline.min(end))
    }
    pub(super) fn read_fixed_inputs(&mut self) -> Result<()> {
        if self.inputs.is_some() {
            return Err(Cause::Refused("FLEET_PREVIEW_INPUTS_ALREADY_CAPTURED"));
        }
        let reference = fixed_reference()?;
        let end = self.original_end();
        let raw = self
            .frame
            .as_mut()
            .expect("same original Q")
            .input
            .observe_artifact(&reference, ImmutableInputKind::PoolImageInputs, end)
            .map_err(ResourceActorError::from)?;
        self.inputs = Some(PoolInputs {
            reference,
            raw,
            document: None,
        });
        let inputs = self
            .inputs
            .as_mut()
            .expect("actual bytes retained before decoding");
        inputs.document = Some(PoolImageInputsData::decode(inputs.raw.bytes())?);
        Ok(())
    }
    pub(super) fn assert_inputs_current(&mut self) -> Result<()> {
        let end = self.original_end();
        let inputs = self
            .inputs
            .as_ref()
            .ok_or(Cause::Refused("FLEET_PREVIEW_FIXED_POOL_INPUTS_REQUIRED"))?;
        if fixed_reference()? != inputs.reference {
            return Err(Cause::Refused("FLEET_PREVIEW_FIXED_POOL_INPUTS_CHANGED"));
        }
        let current = self
            .frame
            .as_mut()
            .expect("same original Q")
            .input
            .observe_artifact(&inputs.reference, ImmutableInputKind::PoolImageInputs, end)
            .map_err(ResourceActorError::from)?;
        if current.bytes() != inputs.raw.bytes() || current.identity() != inputs.raw.identity() {
            return Err(Cause::Refused("FLEET_PREVIEW_FIXED_POOL_INPUTS_CHANGED"));
        }
        Ok(())
    }
    pub(super) fn compare_fixed_images(&mut self) -> Result<()> {
        let binding = self
            .target
            .as_mut()
            .expect("same original target")
            .current()?;
        let inputs = self
            .inputs
            .as_ref()
            .and_then(|i| i.document.as_ref())
            .ok_or(Cause::Refused("FLEET_PREVIEW_FIXED_POOL_INPUTS_REQUIRED"))?;
        let actual = self
            .target
            .as_mut()
            .expect("same original target")
            .qualify_images(inputs)?;
        if actual[0] != binding.policy().anchor_image
            || actual[1] != binding.policy().controller_image
        {
            return Err(Cause::Refused("FLEET_PREVIEW_FIXED_POOL_IMAGES_CHANGED"));
        }
        Ok(())
    }
}
impl PoolInputs {
    pub(super) fn binding_data(&self) -> serde_json::Value {
        serde_json::json!({"sha256":self.reference.sha256.as_str(),"identity":self.raw.identity()})
    }
}
