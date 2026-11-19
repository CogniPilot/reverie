//! Compatibility JSON for the named Nix profile scopes, including filesystem
//! names decoded through the existing surrogateescape boundary.
use crate::legacy_json::{Node, Number, Text, Value, ordered::OrderedValue};
use std::{collections::BTreeMap, fmt};

pub enum ProfileEntry {
    Absent,
    Directory([u64; 4]),
    File([u64; 4]),
    Link([u64; 4], Vec<u32>),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InventoryError {
    Bound,
    Duplicate,
}

impl fmt::Display for InventoryError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(match self {
            Self::Bound => "profile inventory bound",
            Self::Duplicate => "duplicate profile observation",
        })
    }
}
impl std::error::Error for InventoryError {}

pub struct ProfileInventory {
    entries: BTreeMap<Text, ProfileEntry>,
    limit: usize,
}

impl ProfileInventory {
    pub fn require_image_root(&self) -> super::Result<()> {
        let key = ascii("nix:var/nix/gcroots/reverie-image");
        super::require(
            matches!(self.entries.get(&key), Some(ProfileEntry::Link(_, target))
                if target.iter().copied().map(char::from_u32).collect::<Option<String>>()
                    .is_some_and(|target| super::store_path(&target))),
            "existing image GCroot required",
        )
    }

    pub fn new(limit: usize) -> std::result::Result<Self, InventoryError> {
        if limit > 4096 {
            return Err(InventoryError::Bound);
        }
        Ok(Self {
            entries: BTreeMap::new(),
            limit,
        })
    }

    pub fn record(
        &mut self,
        key: Vec<u32>,
        entry: ProfileEntry,
    ) -> std::result::Result<(), InventoryError> {
        if self.entries.len() >= self.limit {
            return Err(InventoryError::Bound);
        }
        match self.entries.entry(Text(key)) {
            std::collections::btree_map::Entry::Vacant(slot) => {
                slot.insert(entry);
                Ok(())
            }
            std::collections::btree_map::Entry::Occupied(_) => Err(InventoryError::Duplicate),
        }
    }

    pub fn bytes(self) -> std::result::Result<Vec<u8>, InventoryError> {
        let entries = self
            .entries
            .into_iter()
            .map(|(key, entry)| (key, encode(entry)))
            .collect();
        let bytes = OrderedValue::object(entries).encode_compact();
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(InventoryError::Bound);
        }
        Ok(bytes)
    }
}

fn encode(entry: ProfileEntry) -> OrderedValue {
    let (kind, identity, target) = match entry {
        ProfileEntry::Absent => ("absent", None, None),
        ProfileEntry::Directory(id) => ("directory", Some(id), None),
        ProfileEntry::File(id) => ("file", Some(id), None),
        ProfileEntry::Link(id, target) => ("link", Some(id), Some(target)),
    };
    let mut fields = Vec::new();
    if let Some(identity) = identity {
        fields.push((
            ascii("identity"),
            OrderedValue::array(
                identity
                    .into_iter()
                    .map(|value| {
                        OrderedValue::scalar(Value(Node::Number(Number::Integer(
                            value.to_string(),
                        ))))
                    })
                    .collect(),
            ),
        ));
    }
    if let Some(target) = target {
        fields.push((
            ascii("target"),
            OrderedValue::scalar(Value(Node::String(Text(target)))),
        ));
    }
    fields.push((
        ascii("type"),
        OrderedValue::scalar(Value(Node::String(ascii(kind)))),
    ));
    OrderedValue::object(fields)
}

fn ascii(value: &str) -> Text {
    Text(value.bytes().map(u32::from).collect())
}
