//! Separate installation-channel hello DATA. No owner consent, installation
//! offer, host authority or employee resource approval can be decoded here.
use super::*;

pub const POOL_REGISTRATION_PURPOSE: &str = "host-pool-registration-v1";

pub fn decode_pool_registration_hello(raw: &[u8]) -> Result<()> {
    let frame = HumanFrame::decode(raw).map_err(frame_error)?;
    let value = frame.value();
    closed(value, &["purpose", "version"])?;
    literal(field(value, "purpose")?, POOL_REGISTRATION_PURPOSE)?;
    need(
        matches!(&field(value,"version")?.0,Node::Number(Number::Integer(value)) if value=="1"),
        "POOL_REGISTRATION_HELLO_VERSION",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installation_and_employee_hellos_cannot_substitute_for_each_other() {
        let registration = br#"{"purpose":"host-pool-registration-v1","version":1}"#;
        let ram = br#"{"purpose":"resource-ram-pool-v2","version":2}"#;
        assert!(decode_pool_registration_hello(registration).is_ok());
        assert!(decode_ram_pool_hello(registration).is_err());
        assert!(decode_pool_registration_hello(ram).is_err());
        for invalid in [
            br#"{"purpose":"host-pool-registration-v1","version":true}"#.as_slice(),
            br#"{"purpose":"host-pool-registration-v1","version":1.0}"#,
            br#"{"purpose":"host-pool-registration-v1","version":2}"#,
            br#"{"purpose":"host-pool-registration-v1","version":1,"owner":true}"#,
            br#"{"purpose":"host-pool-registration-v1","version":1,"employeeId":"owner"}"#,
            br#"{"purpose":"resource-ram-pool-v2","purpose":"host-pool-registration-v1","version":1}"#,
        ] {
            assert!(decode_pool_registration_hello(invalid).is_err());
        }
    }
}
