use super::*;
impl NominationDerivation {
    pub(super) fn find_images(
        &mut self,
        runtime: &WorkerRuntime,
        inputs: &PoolImageInputsData,
    ) -> Result<[String; 2]> {
        let raw = self.query(runtime, EngineQuery::WorkerPoolImageInventory)?;
        let mut ids = BTreeSet::new();
        for line in raw.lines() {
            let id = reverie_contracts::worker_image_switch::WorkerImageId::parse(line)
                .map_err(|_| PoolNominationError::Refused("POOL_NOMINATION_IMAGE_INVENTORY"))?;
            ids.insert(id.as_str().to_owned());
            need(ids.len() <= 256, "POOL_NOMINATION_IMAGE_BOUND")?;
        }
        need(!ids.is_empty(), "POOL_NOMINATION_IMAGES_NOT_LOADED")?;
        let mut selected: [Option<String>; 2] = [None, None];
        for value in ids {
            let id = reverie_contracts::worker_image_switch::WorkerImageId::parse(&value)
                .map_err(|_| PoolNominationError::Refused("POOL_NOMINATION_IMAGE_INVENTORY"))?;
            let raw = self.query(runtime, EngineQuery::WorkerImageInspect(&id))?;
            let image = EngineMetadata::decode(raw.as_bytes())?;
            for (index, role) in [PoolImageRole::Anchor, PoolImageRole::Controller]
                .into_iter()
                .enumerate()
            {
                if let Ok(found) = image.qualify_pool_image(inputs, role) {
                    need(found == value, "POOL_NOMINATION_IMAGE_ID_CHANGED")?;
                    need(selected[index].is_none(), "POOL_NOMINATION_IMAGE_AMBIGUOUS")?;
                    selected[index] = Some(found);
                }
            }
        }
        let [anchor, controller] = selected;
        let anchor = anchor.ok_or(PoolNominationError::Refused(
            "POOL_NOMINATION_ANCHOR_NOT_LOADED",
        ))?;
        let controller = controller.ok_or(PoolNominationError::Refused(
            "POOL_NOMINATION_CONTROLLER_NOT_LOADED",
        ))?;
        need(anchor != controller, "POOL_NOMINATION_IMAGE_AMBIGUOUS")?;
        Ok([anchor, controller])
    }
}
