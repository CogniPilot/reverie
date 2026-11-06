use reverie_core::decimal::UnsignedInteger as Integer;
use std::num::NonZeroU32;
fn value(raw: &str) -> Integer {
    Integer::parse(raw).unwrap()
}
#[test]
fn shared_exact_arithmetic_preserves_carry_borrow_and_each_domain_bound() {
    assert_eq!(
        value("999999999999999999999999999999")
            .plus(&value("1"))
            .as_str(),
        "1000000000000000000000000000000"
    );
    assert_eq!(
        value("1000000000000000000000000000000")
            .minus(&value("1"))
            .unwrap()
            .as_str(),
        "999999999999999999999999999999"
    );
    assert!(value("1").minus(&value("2")).is_none());
    assert!(value("18446744073709551616").to_u64().is_none());
    assert_eq!(value("512").times(1_048_576).as_str(), "536870912");
    assert_eq!(
        value("536870912").remainder(NonZeroU32::new(1_048_576).unwrap()),
        0
    );
    assert_eq!(value("0000"), value("0"));
    assert!(
        reverie_core::capacity::CapacityCounter::from_integer(&value("9223372036854775808"))
            .is_err()
    );
    assert!(reverie_core::rootless::SubordinateId::parse("9223372036854775808").is_some());
}
