//! Pure time-bound DATA checks, not fabricated qualified/native owner tests.
use super::*;
#[test]
fn original_deadline_bounds_the_separate_human_consent_window() {
    let now = Instant::now();
    let epoch = 1_000_000;
    let (expires, end) =
        window::consent_window(now + Duration::from_secs(3), epoch + 9000, epoch, now).unwrap();
    assert_eq!(expires, epoch + 3000);
    assert_eq!(end, now + Duration::from_secs(3));
    let (expires, end) =
        window::consent_window(now + Duration::from_secs(20), epoch + 2000, epoch, now).unwrap();
    assert_eq!(expires, epoch + 20_000);
    assert_eq!(end, now + Duration::from_secs(20));
}
#[test]
fn expired_originals_and_overflow_refuse_without_a_new_window() {
    let now = Instant::now();
    let end = now + Duration::from_secs(20);
    assert!(window::consent_window(now, 1001, 1000, now).is_err());
    assert!(window::consent_window(end, 1000, 1000, now).is_err());
    assert!(window::consent_window(end, 11001, 1000, now).is_err());
    assert!(window::consent_window(end, u64::MAX, u64::MAX, now).is_err());
    assert!(window::assert_window(now - Duration::from_secs(1), u64::MAX).is_err());
    assert!(window::assert_window(end, 1).is_err());
}
