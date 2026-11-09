//! No background reader or cloned receiver. The actual operation can move this
//! whole owner into its L rendezvous while the Q service waits for its return.
use super::*;
use reverie_contracts::human_protocol::MAX_FRAME;
impl Frame<'_> {
    fn take_bytes(&mut self, count: usize, end: Instant) -> Result<Vec<u8>> {
        let mut raw = Vec::with_capacity(count);
        while raw.len() < count {
            self.guard_peer(end)?;
            let chunk = self
                .channel()?
                .receive_chunk((count - raw.len()).min(MAX_FRAME), end)?;
            self.guard_peer(end)?;
            need(!chunk.is_empty(), "RESOURCE_ACTOR_CHANNEL_ENDED")?;
            raw.extend(chunk);
        }
        Ok(raw)
    }
    pub(super) fn receive(&mut self, end: Instant) -> Result<HumanFrame> {
        self.frames += 1;
        need(self.frames <= 2048, "RESOURCE_ACTOR_FRAME_BOUND")?;
        let header = self.take_bytes(4, end)?;
        let count = u32::from_be_bytes(header.try_into().expect("length header")) as usize;
        need(
            (1..=MAX_FRAME).contains(&count),
            "RESOURCE_ACTOR_FRAME_BOUND",
        )?;
        Ok(HumanFrame::decode_canonical(&self.take_bytes(count, end)?)?)
    }
    pub(super) fn send(&mut self, frame: &HumanFrame, end: Instant) -> Result<()> {
        self.guard_peer(end)?;
        self.channel()?.send_frame(frame, end)?;
        self.guard_peer(end)
    }
}
