//! Fixed provider-probe DATA parsers. None of these values grant an action.
#[cfg(test)]
mod tests {
    use super::*;
    use reverie_core::decimal::UnsignedInteger;
    #[test]
    fn pane_and_top_are_closed_bounded_native_data() {
        let pane = ProviderPane::decode("0|42\n").unwrap();
        assert!(!pane.dead());
        assert_eq!(pane.guest_pid().as_str(), "42");
        assert_eq!(ProviderTopology::decode("PID PPID\n123 1\n456 123\n").unwrap().pairs().len(), 2);
        for bad in ["PID PPID\n123 1\n123 2\n", "PID\n123\n", "PID PPID\n0 1\n"] {
            assert!(ProviderTopology::decode(bad).is_err());
        }
        for bad in ["2|42", "0|0", "0|42|3", "0|true"] { assert!(ProviderPane::decode(bad).is_err()); }
    }
    #[test]
    fn namespace_pid_requires_one_exact_host_selected_row() {
        let pid = UnsignedInteger::from_u64(123);
        assert_eq!(namespace_pid(b"Name:\tfixture\nNSpid:\t123\t42\n", &pid).unwrap().as_str(), "42");
        for bad in [b"NSpid:\t124\t42\n".as_slice(), b"NSpid:\t123\nNSpid:\t123\n", b"NSpid:\t123\ttrue\n"] {
            assert!(namespace_pid(bad, &pid).is_err());
        }
    }
}
