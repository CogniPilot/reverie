use super::*;
use reverie_core::ids::ProfileSessionId;
impl InstallingBroker {
    pub(super) fn observe_image(
        &self,
        session: &ProfileSessionId,
        cache: bool,
    ) -> Result<Observation> {
        let observed = self.observe_image_inner(session, cache);
        if cache {
            observed.map_err(|error| ChatImagesError::Current(Box::new(error)))
        } else {
            observed
        }
    }
    fn observe_image_inner(&self, session: &ProfileSessionId, cache: bool) -> Result<Observation> {
        let runtime = &self.storage.runtime;
        need(!runtime.cancellation().is_cancelled(), "laptop_unavailable")?;
        let generation = self
            .installed
            .capture_generation()
            .map_err(|_| ChatImagesError::Refused("laptop_unavailable"))?;
        self.installed
            .lifecycle()
            .and_then(|life| life.check_generation(&generation))
            .map_err(|_| ChatImagesError::Refused("laptop_unavailable"))?;
        need(
            self.allowed(session)
                .map_err(|_| ChatImagesError::Refused("laptop_unavailable"))?,
            "laptop_unavailable",
        )?;
        let source = self
            .configuration()
            .map_err(|_| ChatImagesError::Refused("materialization_unavailable"))?;
        let prefix = if cache {
            runtime.observe_chat_image_cache_namespace(source.configuration(), session)
        } else {
            runtime.observe_chat_image_namespace(source.configuration(), session)
        }
        .map_err(|error| ChatImagesError::Observation {
            code: error.error().code(),
            error,
        })?;
        let office = {
            let life = self
                .installed
                .lifecycle()
                .map_err(|_| ChatImagesError::Refused("laptop_unavailable"))?;
            let entry = life
                .guard
                .iter()
                .find(|entry| &entry.session == session)
                .ok_or(ChatImagesError::Refused("office_unavailable"))?;
            match &entry.owner {
                LaptopOwner::Recovered(owner) => owner.office.clone(),
                LaptopOwner::Started(owner) => owner.office.clone(),
                #[cfg(test)]
                LaptopOwner::Modeled => return Err(ChatImagesError::Refused("office_unavailable")),
            }
        };
        // Capture the actual registered Office Arc under life, then release the
        // global lifecycle BEFORE registry waits/native metadata/filesystem I/O.
        let phone = office
            ._office
            .image_binding(&office._phone, runtime)
            .map_err(|error| ChatImagesError::Cache(ImageCacheError::Office(error)))?;
        let binding = prefix
            .bind_office(runtime, &phone, generation.serial())
            .map_err(ChatImagesError::Native)?;
        self.installed
            .lifecycle()
            .and_then(|life| life.check_generation(&generation))
            .map_err(|_| ChatImagesError::Refused("binding_changed"))?;
        need(
            !runtime.cancellation().is_cancelled()
                && self
                    .allowed(session)
                    .map_err(|_| ChatImagesError::Refused("binding_changed"))?,
            "binding_changed",
        )?;
        Ok(Observation { binding, phone })
    }
}
