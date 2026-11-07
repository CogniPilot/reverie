use super::*;
/// Incremental inspected-mount declarations. The caller must complete the real
/// source resolve/identity before asking for the next mount, preserving native
/// failure order. No request-selected credential contents are read.
pub struct AccountDeclarations<'a> {
    mounts: std::slice::Iter<'a, Value>,
}
pub struct AccountDeclaration<'a> {
    fields: &'a Object,
    destination: &'a Text,
}
#[derive(Clone)]
pub struct ObservedAccount {
    source: MetadataText,
    destination: MetadataText,
    identity: [u64; 4],
}
impl ObservedAccount {
    pub fn source(&self) -> &MetadataText {
        &self.source
    }
    pub fn destination(&self) -> &MetadataText {
        &self.destination
    }
    pub fn identity(&self) -> [u64; 4] {
        self.identity
    }
}
impl<'a> AccountDeclarations<'a> {
    pub fn new(row: &'a ContainerRow) -> Result<Self> {
        Ok(Self {
            mounts: row.mounts().map_err(|_| BaselineDataError::Account)?.iter(),
        })
    }
    pub fn next_declaration(&mut self) -> Result<Option<AccountDeclaration<'a>>> {
        for value in self.mounts.by_ref() {
            let fields = object(value)?;
            let destination = match field(fields, "Destination") {
                None => continue,
                value => text(value)?,
            };
            if [
                "/instances/default/accounts/",
                "/instances/default/console/accounts/",
            ]
            .iter()
            .any(|prefix| {
                destination
                    .0
                    .starts_with(&prefix.chars().map(u32::from).collect::<Vec<_>>())
            }) {
                return Ok(Some(AccountDeclaration {
                    fields,
                    destination,
                }));
            }
        }
        Ok(None)
    }
}
impl AccountDeclaration<'_> {
    pub fn source(&self) -> Result<MetadataText> {
        Ok(MetadataText::from_text(
            text(field(self.fields, "Source"))?.clone(),
        ))
    }
    pub fn source_path(&self) -> Result<PosixPath> {
        let value = self.source()?;
        let path =
            PosixPath::try_new(value.codepoints()).map_err(|_| BaselineDataError::Account)?;
        need(path.is_absolute(), BaselineDataError::Account)?;
        Ok(path)
    }
    /// This pure structure check runs only AFTER the native source resolve.
    /// Original source/destination spellings survive in returned baseline data.
    pub fn validate_resolved(&self, resolved: &PosixPath) -> Result<()> {
        need(*resolved == self.source_path()?, BaselineDataError::Account)?;
        let destination =
            PosixPath::try_new(&self.destination.0).map_err(|_| BaselineDataError::Account)?;
        need(
            !destination.has_parent_component()
                && matches!(field(self.fields,"Type"),Some(Value(Node::String(value))) if value.equals_ascii("bind"))
                && matches!(field(self.fields, "RW"), Some(Value(Node::Bool(true)))),
            BaselineDataError::Account,
        )
    }
    pub fn destination(&self) -> MetadataText {
        MetadataText::from_text(self.destination.clone())
    }
    pub fn observe(&self, identity: [u64; 4]) -> Result<ObservedAccount> {
        Ok(ObservedAccount {
            source: self.source()?,
            destination: self.destination(),
            identity,
        })
    }
}
