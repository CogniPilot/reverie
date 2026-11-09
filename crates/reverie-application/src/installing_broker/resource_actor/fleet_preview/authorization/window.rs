//! Time bounds only; these values cannot mint a preview or owner grant.
use super::*;
pub(super) fn consent_window(
    original: Instant,
    viewer: u64,
    epoch: u64,
    now: Instant,
) -> Result<(u64, Instant)> {
    let latest = epoch
        .checked_add(OWNER_FRESHNESS_MILLIS)
        .ok_or(Cause::Refused("FLEET_PREVIEW_EXPIRY"))?;
    if original <= now || viewer <= epoch || viewer > latest {
        return Err(Cause::Refused("FLEET_PREVIEW_EXPIRY"));
    }
    let millis = u64::try_from(original.duration_since(now).as_millis())
        .map_err(|_| Cause::Refused("FLEET_PREVIEW_EXPIRY"))?;
    let expires = viewer.min(
        epoch
            .checked_add(millis)
            .ok_or(Cause::Refused("FLEET_PREVIEW_EXPIRY"))?,
    );
    if expires <= epoch {
        return Err(Cause::Refused("FLEET_PREVIEW_EXPIRY"));
    }
    let end = now
        .checked_add(Duration::from_millis(expires - epoch))
        .ok_or(Cause::Refused("FLEET_PREVIEW_EXPIRY"))?
        .min(original);
    Ok((expires, end))
}
pub(super) fn assert_window(end: Instant, expires: u64) -> Result<()> {
    if Instant::now() >= end || owner::epoch()? >= expires {
        return Err(Cause::Refused("FLEET_PREVIEW_EXPIRY"));
    }
    Ok(())
}
