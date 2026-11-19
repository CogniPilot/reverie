use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Serialize)]
pub(crate) struct Finding {
    pub(crate) detector: &'static str,
    #[serde(rename = "where")]
    pub(crate) location: String,
}

#[derive(Default, Serialize)]
pub(crate) struct Count {
    pub(crate) files: u64,
    pub(crate) bytes: u64,
}

#[derive(Default, Serialize)]
pub(crate) struct Report {
    pub(crate) layers: usize,
    pub(crate) findings: Vec<Finding>,
    pub(crate) clean: bool,
    pub(crate) unread_third_party: BTreeMap<&'static str, Count>,
}

impl Report {
    pub(crate) fn finding(&mut self, location: &str, detector: &'static str) {
        self.findings.push(Finding {
            detector,
            location: location.to_owned(),
        });
    }

    pub(crate) fn skip_contents(&mut self, prefix: &'static str, bytes: u64) {
        let count = self.unread_third_party.entry(prefix).or_default();
        count.files += 1;
        count.bytes += bytes;
    }
}
