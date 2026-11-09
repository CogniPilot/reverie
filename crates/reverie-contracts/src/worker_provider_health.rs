//! Fixed provider-probe DATA parsers. None of these values grant an action.
use reverie_core::decimal::UnsignedInteger;
use std::collections::BTreeSet;
type Result<T> = std::result::Result<T, &'static str>;
pub struct ProviderPane {
    dead: bool,
    guest: UnsignedInteger,
}
impl ProviderPane {
    pub fn decode(raw: &str) -> Result<Self> {
        let (dead, pid) = raw.trim().split_once('|').ok_or("PROVIDER_PANE")?;
        if !matches!(dead, "0" | "1") {
            return Err("PROVIDER_PANE");
        }
        Ok(Self {
            dead: dead == "1",
            guest: pid_number(pid, 1)?,
        })
    }
    pub fn dead(&self) -> bool {
        self.dead
    }
    pub fn guest_pid(&self) -> &UnsignedInteger {
        &self.guest
    }
}
pub struct ProviderTopology {
    pairs: Vec<(UnsignedInteger, UnsignedInteger)>,
}
impl ProviderTopology {
    pub fn decode(raw: &str) -> Result<Self> {
        if raw.len() > 4 * 1024 * 1024 || !raw.is_ascii() {
            return Err("PROVIDER_TOP_BOUND");
        }
        let mut lines = raw.lines();
        if lines
            .next()
            .map(|line| line.split_whitespace().collect::<Vec<_>>())
            != Some(vec!["PID", "PPID"])
        {
            return Err("PROVIDER_TOP_HEADER");
        }
        let mut pairs = Vec::new();
        let mut seen = BTreeSet::new();
        for line in lines {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() != 2 || pairs.len() >= 512 {
                return Err("PROVIDER_TOP_BOUND");
            }
            let pid = pid_number(fields[0], 1)?;
            if !seen.insert(pid.clone()) {
                return Err("PROVIDER_TOP_DUPLICATE");
            }
            let parent = if fields[1] == "0" {
                UnsignedInteger::from_u64(0)
            } else {
                pid_number(fields[1], 0)?
            };
            pairs.push((pid, parent));
        }
        if pairs.is_empty() {
            return Err("PROVIDER_TOP_EMPTY");
        }
        Ok(Self { pairs })
    }
    pub fn pairs(&self) -> &[(UnsignedInteger, UnsignedInteger)] {
        &self.pairs
    }
}
fn pid_number(raw: &str, minimum: u64) -> Result<UnsignedInteger> {
    UnsignedInteger::parse(raw)
        .filter(|pid| {
            pid.to_u64()
                .is_some_and(|pid| pid > minimum && u32::try_from(pid).is_ok())
        })
        .ok_or("PROVIDER_PID")
}
pub fn namespace_pid(raw: &[u8], host: &UnsignedInteger) -> Result<UnsignedInteger> {
    if raw.len() > 16384 || !raw.is_ascii() {
        return Err("PROVIDER_NSPID_BOUND");
    }
    let text = std::str::from_utf8(raw).expect("ASCII");
    let rows = text
        .lines()
        .filter_map(|line| line.strip_prefix("NSpid:"))
        .collect::<Vec<_>>();
    if rows.len() != 1 {
        return Err("PROVIDER_NSPID");
    }
    let values = rows[0]
        .split_whitespace()
        .map(|value| pid_number(value, 0))
        .collect::<Result<Vec<_>>>()?;
    if values.is_empty() || values.len() > 32 || &values[0] != host {
        return Err("PROVIDER_NSPID");
    }
    Ok(values.last().expect("nonempty").clone())
}
#[cfg(test)]
mod tests {
    use super::*;
    use reverie_core::decimal::UnsignedInteger;
    #[test]
    fn pane_and_top_are_closed_bounded_native_data() {
        let pane = ProviderPane::decode("0|42\n").unwrap();
        assert!(!pane.dead());
        assert_eq!(pane.guest_pid().as_str(), "42");
        assert_eq!(
            ProviderTopology::decode("PID PPID\n123 1\n456 123\n")
                .unwrap()
                .pairs()
                .len(),
            2
        );
        for bad in ["PID PPID\n123 1\n123 2\n", "PID\n123\n", "PID PPID\n0 1\n"] {
            assert!(ProviderTopology::decode(bad).is_err());
        }
        for bad in ["2|42", "0|0", "0|42|3", "0|true"] {
            assert!(ProviderPane::decode(bad).is_err());
        }
    }
    #[test]
    fn namespace_pid_requires_one_exact_host_selected_row() {
        let pid = UnsignedInteger::from_u64(123);
        assert_eq!(
            namespace_pid(b"Name:\tfixture\nNSpid:\t123\t42\n", &pid)
                .unwrap()
                .as_str(),
            "42"
        );
        for bad in [
            b"NSpid:\t124\t42\n".as_slice(),
            b"NSpid:\t123\nNSpid:\t123\n",
            b"NSpid:\t123\ttrue\n",
        ] {
            assert!(namespace_pid(bad, &pid).is_err());
        }
    }
}
