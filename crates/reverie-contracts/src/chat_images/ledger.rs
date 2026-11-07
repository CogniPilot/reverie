use super::*;
use reverie_core::{
    chat_images::{ImageFileName, MAX_CACHE_FILES, MAX_FILE_BYTES},
    decimal::UnsignedInteger,
};
use std::collections::BTreeSet;
#[derive(Clone)]
pub struct LedgerEntry {
    name: ImageFileName,
    inode: [UnsignedInteger; 2],
    size: usize,
    digest: ImageDigest,
}
impl LedgerEntry {
    pub fn try_new(
        name: ImageFileName,
        inode: [UnsignedInteger; 2],
        size: usize,
        digest: ImageDigest,
    ) -> Result<Self> {
        need((1..=MAX_FILE_BYTES).contains(&size), "custody_unavailable")?;
        Ok(Self {
            name,
            inode,
            size,
            digest,
        })
    }
    pub fn name(&self) -> &ImageFileName {
        &self.name
    }
    pub fn size(&self) -> usize {
        self.size
    }
    pub fn digest(&self) -> &ImageDigest {
        &self.digest
    }
    pub fn inode_matches(&self, actual: [u64; 2]) -> bool {
        self.inode == actual.map(UnsignedInteger::from_u64)
    }
}
pub struct ImageLedger {
    cache: [UnsignedInteger; 2],
    entries: Vec<LedgerEntry>,
}
impl ImageLedger {
    pub fn try_new(cache: [UnsignedInteger; 2], entries: Vec<LedgerEntry>) -> Result<Self> {
        need(
            entries.len() <= MAX_CACHE_FILES
                && entries
                    .iter()
                    .map(|e| e.name.as_str())
                    .collect::<BTreeSet<_>>()
                    .len()
                    == entries.len(),
            "custody_unavailable",
        )?;
        Ok(Self { cache, entries })
    }
    pub fn entries(&self) -> &[LedgerEntry] {
        &self.entries
    }
    pub fn cache_matches(&self, actual: [u64; 2]) -> bool {
        self.cache == actual.map(UnsignedInteger::from_u64)
    }
}
fn integer(value: &Value) -> Result<UnsignedInteger> {
    let Node::Number(Number::Integer(value)) = &value.0 else {
        return Err(ImageDataError("custody_unavailable"));
    };
    UnsignedInteger::parse(value).ok_or(ImageDataError("custody_unavailable"))
}
fn pair(value: Option<&Value>) -> Result<[UnsignedInteger; 2]> {
    let Some(Value(Node::Array(values))) = value else {
        return Err(ImageDataError("custody_unavailable"));
    };
    need(values.len() == 2, "custody_unavailable")?;
    Ok([integer(&values[0])?, integer(&values[1])?])
}
fn entry(value: &Value) -> Result<LedgerEntry> {
    let fields = object(value, "custody_unavailable")?;
    need(fields.len() == 4, "custody_unavailable")?;
    let name = ImageFileName::parse(&text(field(fields, "name"), "custody_unavailable")?)
        .ok_or(ImageDataError("custody_unavailable"))?;
    let inode = pair(field(fields, "inode"))?;
    let size = integer(field(fields, "size").ok_or(ImageDataError("custody_unavailable"))?)?
        .to_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or(ImageDataError("custody_unavailable"))?;
    let digest = ImageDigest::parse(&text(field(fields, "sha256"), "custody_unavailable")?)
        .ok_or(ImageDataError("custody_unavailable"))?;
    LedgerEntry::try_new(name, inode, size, digest)
}
pub fn decode_ledger(raw: &[u8]) -> Result<ImageLedger> {
    let value = legacy_json::decode_metadata_bytes(raw)
        .map_err(|_| ImageDataError("custody_unavailable"))?;
    let fields = object(&value, "custody_unavailable")?;
    need(
        fields.len() == 3
            && matches!(field(fields,"version"),Some(Value(Node::Number(Number::Integer(v))))if v=="1"),
        "custody_unavailable",
    )?;
    let cache = pair(field(fields, "cache"))?;
    let Some(Value(Node::Array(entries))) = field(fields, "entries") else {
        return Err(ImageDataError("custody_unavailable"));
    };
    let entries = entries.iter().map(entry).collect::<Result<Vec<_>>>()?;
    ImageLedger::try_new(cache, entries)
}
fn encoded_pair(pair: &[UnsignedInteger; 2]) -> String {
    format!("[{},{}]", pair[0].as_str(), pair[1].as_str())
}
pub fn encode_ledger(ledger: &ImageLedger) -> Vec<u8> {
    let entries = ledger
        .entries
        .iter()
        .map(|entry| {
            format!(
                "{{\"inode\":{},\"name\":\"{}\",\"sha256\":\"{}\",\"size\":{}}}",
                encoded_pair(&entry.inode),
                entry.name.as_str(),
                entry.digest.as_str(),
                entry.size
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"cache\":{},\"entries\":[{entries}],\"version\":1}}",
        encoded_pair(&ledger.cache)
    )
    .into_bytes()
}
