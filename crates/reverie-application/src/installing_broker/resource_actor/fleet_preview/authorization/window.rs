//! Time bounds only; these values cannot mint a preview or owner grant.
use super::*;
const HUMAN_CONSENT_MILLIS: u64 = 120_000;
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
    // The short owner echo proves current issuance authority. Human consent
    // has its own window, without extending the original frame/offer budget.
    let expires = epoch
        .checked_add(millis.min(HUMAN_CONSENT_MILLIS))
        .ok_or(Cause::Refused("FLEET_PREVIEW_EXPIRY"))?;
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
