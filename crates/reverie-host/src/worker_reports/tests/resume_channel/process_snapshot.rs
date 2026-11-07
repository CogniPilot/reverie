//! Genuine accepted/pinned channel, with actual local kernel status. This host
//! is not presumed to have NoNewPrivs or an empty capability bounding set.
use super::*;
use crate::website_facts::WebsiteProcessObserver;
#[test]
fn actual_channel_peer_uses_kernel_identity_and_status_then_closed_channel_refuses() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (client, mut channel) = channel(&fixture, &service);
    let status = std::fs::read_to_string("/proc/self/status").unwrap();
    let fields: std::collections::BTreeMap<_, _> = status
        .lines()
        .filter_map(|line| line.split_once(':'))
        .collect();
    let protected = fields
        .get("NoNewPrivs")
        .is_some_and(|value| value.trim() == "1")
        && ["CapInh", "CapPrm", "CapEff", "CapAmb", "CapBnd"]
            .iter()
            .all(|key| {
                fields.get(key).is_some_and(|value| {
                    !value.trim().is_empty() && value.trim().bytes().all(|byte| byte == b'0')
                })
            });
    let mut observer = WebsiteProcessObserver::default();
    let result = observer.observe_peer(&mut channel, end());
    let closed = channel.close_for_worker();
    let refused = observer.observe_peer(&mut channel, end());
    super::super::super::record::close(client).unwrap();
    service.close(end()).unwrap();
    closed.unwrap();
    assert!(refused.is_err());
    if protected {
        let value = result.unwrap();
        assert_eq!(value.peer().pid(), std::process::id() as i32);
        assert_eq!(value.peer().uid(), crate::native::uid());
        assert_eq!(
            value.process().pid().to_u64(),
            Some(u64::from(std::process::id()))
        );
    } else {
        assert_eq!(
            result.err().unwrap().code(),
            "BACKEND_KERNEL_PRIVILEGE_CHANGED"
        );
    }
}
