use super::*;
impl NativeFleetPreview<'_> {
    pub(super) fn close_components(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        let frame = self.frame.as_mut().expect("original Q frame retained");
        let end = frame
            .broker
            .storage
            .runtime
            .stop_deadline()
            .map_or(frame.deadline, |stop| frame.deadline.min(stop));
        // Both independent scopes are attempted even when either refuses.
        let target = self
            .target
            .as_mut()
            .expect("original target attempt retained")
            .close();
        let metadata = frame.close_metadata(end);
        match (target, metadata) {
            (Ok(_target), Ok(metadata)) => match metadata.finish() {
                Ok(WorkerLaunchClose::SocketClosedLifecycleHeld) => {
                    self.frame_cleanup.get_or_insert_with(|| {
                        Rc::new(Cause::Refused("FLEET_PREVIEW_Q_HOLD_RETAINED"))
                    });
                }
                Ok(_) => {
                    self.closed = true;
                    return Ok(());
                }
                Err(cause) => {
                    self.frame_cleanup
                        .get_or_insert_with(|| Rc::new(Cause::Actor(cause)));
                }
            },
            (target, metadata) => {
                if let Err(cause) = target {
                    self.target_cleanup.get_or_insert_with(|| Rc::new(cause));
                }
                if let Err(cause) = metadata {
                    self.frame_cleanup
                        .get_or_insert_with(|| Rc::new(Cause::Actor(cause)));
                }
            }
        }
        Err(Cause::Refused("FLEET_PREVIEW_COMPONENT_RETAINED"))
    }
}
