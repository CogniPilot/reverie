use super::*;
use reverie_host::worker_reports::WorkerServicePurpose;
impl InstallingBroker {
    /// A genuine kernel-authenticated M Record is the only input. This method
    /// owns its finalization/failure and never returns an error-only orphan.
    pub fn handle_chat_images(
        &self,
        connection: WorkerServiceConnection,
    ) -> std::result::Result<ChatImageHandlerClosed, Box<ChatImageHandlerFailure>> {
        let mut owner = HandlerOwner {
            connection,
            hold: None,
            permit: None,
            batch: None,
            capture: None,
        };
        let origin = owner
            .connection
            .assert_service(&self.reports)
            .map_err(ChatImagesError::Report)
            .and_then(|()| {
                need(
                    owner.connection.purpose() == WorkerServicePurpose::ChatImages
                        && owner.connection.same_runtime(&self.storage.runtime),
                    "invalid_request",
                )
            });
        if let Err(primary) = origin {
            return Err(Box::new(ChatImageHandlerFailure {
                owner: Some(owner),
                primary: Some(primary),
                cleanup: Vec::new(),
            }));
        }
        let held = owner
            .connection
            .retain_lifecycle()
            .map_err(ChatImagesError::Report);
        match held {
            Ok(hold) => owner.hold = Some(hold),
            Err(primary) => {
                return Err(Box::new(ChatImageHandlerFailure {
                    owner: Some(owner),
                    primary: Some(primary),
                    cleanup: Vec::new(),
                }));
            }
        }
        let body = self.images.admit().and_then(|permit| {
            owner.permit = Some(permit);
            self.image_body(&mut owner)
        });
        self.finish_images(owner, body)
    }
    fn finish_images(
        &self,
        mut owner: HandlerOwner,
        body: Result<Vec<u8>>,
    ) -> std::result::Result<ChatImageHandlerClosed, Box<ChatImageHandlerFailure>> {
        let mut cleanup = Vec::new();
        let mut primary = match body {
            Ok(response) => owner
                .connection
                .reply_json(&response)
                .err()
                .map(ChatImagesError::Report),
            Err(error) => {
                if let Some(batch) = owner.batch.as_mut() {
                    match batch.abort() {
                        Ok(()) => owner.batch = None,
                        Err(error) => cleanup.push(ChatImagesError::Cache(error)),
                    }
                }
                Some(match owner.connection.report_failure(error.code()) {
                    Ok(()) => error,
                    Err(cause) => ChatImagesError::Delivery {
                        body: Box::new(error),
                        cause,
                    },
                })
            }
        };
        let pending = primary.as_ref().is_some_and(ChatImagesError::pending)
            || owner.batch.is_some()
            || owner
                .capture
                .as_ref()
                .is_some_and(|failure| failure.retained.is_some() || failure.store.is_some());
        if let Err(error) = owner.connection.close_socket_for_worker() {
            cleanup.push(ChatImagesError::Report(error));
        }
        if !pending
            && cleanup.is_empty()
            && let Some(hold) = owner.hold.as_mut()
            && let Err(error) = hold.release_for_worker()
        {
            cleanup.push(ChatImagesError::Report(error));
        }
        if pending || !cleanup.is_empty() {
            return Err(Box::new(ChatImageHandlerFailure {
                owner: Some(owner),
                primary,
                cleanup,
            }));
        }
        if let Some(permit) = owner.permit.as_mut() {
            permit.release();
        }
        // Manager adoption/actual native close, socket known-close and original
        // Hold release are complete; handler JoinHandle belongs to its service.
        Ok(ChatImageHandlerClosed {
            primary: primary.take(),
        })
    }
}
