//! Kernel process text DATA. The native owner supplies fixed /proc paths and
//! actual channel/incarnation brackets; this parser cannot observe a process.
use super::*;
pub struct ProcessStatData {
    start: UnsignedInteger,
    parent: UnsignedInteger,
}
impl ProcessStatData {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        need(raw.len() <= 8192, "PROCESS_BOUND")?;
        let index = raw
            .iter()
            .rposition(|&byte| byte == b')')
            .ok_or(ResourceActorDataError("PROCESS_STAT_REQUIRED"))?;
        let fields: Vec<_> = raw[index + 1..]
            .split(|byte| matches!(byte, 9..=13 | 32))
            .filter(|field| !field.is_empty())
            .collect();
        let state = fields
            .first()
            .ok_or(ResourceActorDataError("PROCESS_STAT_REQUIRED"))?;
        need(!matches!(*state, b"Z" | b"X"), "PROCESS_ENDED")?;
        let integer = |index| -> Result<UnsignedInteger> {
            let bytes = fields
                .get(index)
                .ok_or(ResourceActorDataError("PROCESS_STAT_REQUIRED"))?;
            let (negative, value) = crate::rootless::parse_python_integer(
                &bytes
                    .iter()
                    .map(|&byte| u32::from(byte))
                    .collect::<Vec<_>>(),
            )
            .ok_or(ResourceActorDataError("PROCESS_STAT_REQUIRED"))?;
            need(!negative, "PROCESS_STAT_REQUIRED")?;
            Ok(value)
        };
        Ok(Self {
            start: integer(19)?,
            parent: integer(1)?,
        })
    }
    pub fn start(&self) -> &UnsignedInteger {
        &self.start
    }
    pub fn parent(&self) -> &UnsignedInteger {
        &self.parent
    }
}
pub fn require_peer_kernel_status(raw: &[u8]) -> Result<()> {
    need(raw.len() <= 65536, "BACKEND_STATUS_BOUND")?;
    need(raw.is_ascii(), "BACKEND_KERNEL_PRIVILEGE_CHANGED")?;
    let text = std::str::from_utf8(raw).expect("ASCII");
    let fields: BTreeMap<_, _> = crate::kernel_accounting::lines(text)
        .into_iter()
        .filter_map(|line| line.split_once(':'))
        .collect();
    need(
        fields
            .get("NoNewPrivs")
            .is_some_and(|value| crate::kernel_accounting::strip(value) == "1")
            && ["CapInh", "CapPrm", "CapEff", "CapAmb", "CapBnd"]
                .iter()
                .all(|key| {
                    fields
                        .get(key)
                        .is_some_and(|value| zero_hex(crate::kernel_accounting::strip(value)))
                }),
        "BACKEND_KERNEL_PRIVILEGE_CHANGED",
    )
}
fn zero_hex(raw: &str) -> bool {
    let raw = raw.strip_prefix(['+', '-']).unwrap_or(raw);
    let raw = if let Some(raw) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
        raw.strip_prefix('_').unwrap_or(raw)
    } else {
        raw
    };
    let mut digit = false;
    for byte in raw.bytes() {
        match byte {
            b'0' => digit = true,
            b'_' if digit => digit = false,
            _ => return false,
        }
    }
    digit
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_comm_and_last_parenthesis_leave_only_kernel_tail_tokens_to_parse() {
        let mut raw = b"123 (nonutf\xff ) parenthesis) S 42 ".to_vec();
        raw.extend_from_slice(b"0 ".repeat(17).as_slice());
        raw.extend_from_slice(b"12345 0");
        let stat = ProcessStatData::decode(&raw).unwrap();
        assert_eq!(stat.start().as_str(), "12345");
        assert_eq!(stat.parent().as_str(), "42");
        for state in [b'Z', b'X'] {
            let index = raw.iter().rposition(|&b| b == b')').unwrap();
            raw[index + 2] = state;
            assert_eq!(
                ProcessStatData::decode(&raw).err().unwrap().code(),
                "PROCESS_ENDED"
            );
        }
        assert_eq!(
            ProcessStatData::decode(&vec![0; 8193])
                .err()
                .unwrap()
                .code(),
            "PROCESS_BOUND"
        );
    }
    #[test]
    fn status_last_keys_ascii_all_five_zero_caps_and_exact_nnp_match_source() {
        let valid = "NoNewPrivs:\t1\nCapInh:\t0\nCapPrm:\t+0x_0\nCapEff:\t-00\nCapAmb:\t0_0\nCapBnd:\t0000000000000000\n";
        assert!(require_peer_kernel_status(valid.as_bytes()).is_ok());
        for name in ["CapInh", "CapPrm", "CapEff", "CapAmb", "CapBnd"] {
            assert!(require_peer_kernel_status(format!("{valid}{name}: 1\n").as_bytes()).is_err());
            assert!(require_peer_kernel_status(format!("{name}: 1\n{valid}").as_bytes()).is_ok());
        }
        for bad in ["0", "01", "+1"] {
            assert!(
                require_peer_kernel_status(format!("{valid}NoNewPrivs: {bad}\n").as_bytes())
                    .is_err()
            );
        }
        assert!(require_peer_kernel_status(&vec![b' '; 65537]).is_err());
        assert!(require_peer_kernel_status("NoNewPrivs: é".as_bytes()).is_err());
        assert!(!zero_hex("0__0"));
        assert!(!zero_hex("0x_"));
        assert!(!zero_hex("_0"));
    }
}
