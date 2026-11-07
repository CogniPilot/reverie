use super::*;
use reverie_contracts::chat_images::{ImageRequest, binding_response, decode_request};
impl InstallingBroker {
    pub(super) fn image_body(&self, owner: &mut HandlerOwner) -> Result<Vec<u8>> {
        let request =
            decode_request(owner.connection.request_bytes()).map_err(ChatImagesError::Codec)?;
        let observed = self.observe_image(request.session(), false)?;
        match request {
            ImageRequest::Binding(session) => {
                Ok(binding_response(&session, observed.binding.generation()))
            }
            ImageRequest::Materialize(scope) => {
                need(
                    observed.binding.generation() == scope.generation(),
                    "binding_changed",
                )?;
                let cache = self.select_image_cache(&scope, observed.binding, owner)?;
                let current = self.observe_image(scope.session(), true)?;
                owner.batch = Some(
                    cache
                        .begin(&self.storage.runtime, scope.clone(), &current.binding)
                        .map_err(ChatImagesError::Cache)?,
                );
                self.materialize_images(owner, &scope)
            }
        }
    }
    fn materialize_images(
        &self,
        owner: &mut HandlerOwner,
        scope: &reverie_core::chat_images::ImageScope,
    ) -> Result<Vec<u8>> {
        for _ in scope.files() {
            let current = self.observe_image(scope.session(), true)?;
            owner
                .batch
                .as_mut()
                .expect("actual batch")
                .fetch_next(&self.storage.runtime, &current.binding)
                .map_err(ChatImagesError::Cache)?;
            let current = self.observe_image(scope.session(), true)?;
            owner
                .batch
                .as_mut()
                .expect("actual batch")
                .install_download(&self.storage.runtime, &current.binding)
                .map_err(ChatImagesError::Cache)?;
        }
        let current = self.observe_image(scope.session(), true)?;
        let batch = owner.batch.as_mut().expect("actual batch");
        let response = batch
            .ready(&self.storage.runtime, &current.binding)
            .map_err(ChatImagesError::Cache)?;
        batch.conclude().map_err(ChatImagesError::Cache)?;
        owner.batch = None;
        Ok(response)
    }
}
