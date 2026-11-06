use reverie_core::rootless::{SubordinateId as Id, SubordinateRange as Range, granted};
fn id(value: &str) -> Id {
    Id::parse(value).unwrap()
}
#[test]
fn subordinate_ranges_use_arbitrary_precision_and_exact_containment() {
    let ranges = [Range::new(id("100000"), id("65536"))];
    assert!(granted(&ranges, &id("100000"), &id("65536")));
    for start in ["0", "99999", "100001"] {
        assert!(!granted(&ranges, &id(start), &id("65536")));
    }
    let huge = "9".repeat(400);
    assert!(granted(
        &[Range::new(id(&huge), id("65537"))],
        &id(&huge),
        &id("65536")
    ));
    assert!(!granted(&ranges, &id("100000"), &id("65535")));
    assert_eq!(id("0000"), id("0"));
    for bad in ["", "-1", "+1", "1_0", "١"] {
        assert!(Id::parse(bad).is_none());
    }
}
