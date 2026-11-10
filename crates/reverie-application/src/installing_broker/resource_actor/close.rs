//! Same original metadata closure and socket disconnection. Only this borrowed
//! receipt can proceed to release the original channel's lifecycle Hold.
use super::*;

pub(super) struct FrameMetadataClosed<'frame, 'broker> {
    frame: &'frame mut Frame<'broker>,
}
impl<'a> Frame<'a> {
    pub(super) fn close(&mut self, end: Instant) -> Result<WorkerLaunchClose> {
        self.close_metadata(end)?.finish()
    }
    pub(super) fn close_metadata(&mut self, end: Instant) -> Result<FrameMetadataClosed<'_, 'a>> {
        self.failed = true;
        let readers: [Result<()>; 9] = [
            if self.employee_close.is_some() {
                Err(ResourceActorError::EmployeeCloseUnconfirmed)
            } else {
                Ok(())
            },
            self.unconfirmed
                .as_ref()
                .map_or(Ok(()), |cause| Err(cause.error())),
            self.private.assert_finalized().map_err(Into::into),
            self.input.assert_finalized().map_err(Into::into),
            self.code.assert_finalized().map_err(Into::into),
            self.aliases.assert_finalized().map_err(Into::into),
            self.processes.assert_finalized().map_err(Into::into),
            self.engine.as_ref().map_or(Ok(()), |engine| {
                engine.assert_finalized().map_err(Into::into)
            }),
            self.context.as_ref().map_or(Ok(()), |context| {
                context.settle_metadata_owned(end).map_err(Into::into)
            }),
        ];
        let readers = readers.into_iter().fold(Ok(()), error::finalized);
        let disconnected = match &mut self.transport {
            Transport::Retained(channel) => channel
                .disconnect_for_worker()
                .map(|_| ())
                .map_err(Into::into),
            _ => Ok(()),
        };
        error::finalized(readers, disconnected)?;
        Ok(FrameMetadataClosed { frame: self })
    }
}
impl FrameMetadataClosed<'_, '_> {
    pub(super) fn finish(self) -> Result<WorkerLaunchClose> {
        let frame = self.frame;
        let closed = match &mut frame.transport {
            Transport::Retained(channel) => channel.close_for_worker()?,
            Transport::Failed(failure) => failure.close_channel_component_for_worker()?,
            Transport::Incoming(connection) => connection.close_socket_for_worker()?,
            Transport::Closed => {
                return Err(ResourceActorError::Refused("RESOURCE_ACTOR_CHANNEL_CLOSED"));
            }
        };
        if closed == WorkerLaunchClose::SocketClosedLifecycleHeld {
            return Ok(closed);
        }
        frame.transport = Transport::Closed;
        frame.context = None;
        Ok(closed)
    }
}
