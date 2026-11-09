//! The existing deployment/company projection. Native registered path, parent,
//! directory and lock custody are separate observations.
use super::ImageDataError;
use crate::{
    legacy_json::{Node, Number, Text, Value},
    storage_identity::{MetadataText, OrderedMetadata},
};
pub struct DeploymentCompanyData {
    container_name: String,
    company_root: MetadataText,
}
impl DeploymentCompanyData {
    pub fn capture(metadata: &OrderedMetadata) -> Result<Self, ImageDataError> {
        let Node::Object(fields) = &metadata.as_value().0 else {
            return Err(ImageDataError::Json);
        };
        let key = |s: &str| Text(s.chars().map(u32::from).collect());
        if !matches!(fields.get(&key("version")),Some(Value(Node::Number(Number::Integer(v)))) if v=="1")
        {
            return Err(ImageDataError::Json);
        }
        let Some(Value(Node::String(container))) = fields.get(&key("containerName")) else {
            return Err(ImageDataError::Json);
        };
        let Some(Value(Node::String(root))) = fields.get(&key("companyRoot")) else {
            return Err(ImageDataError::Json);
        };
        let container_name = container
            .0
            .iter()
            .copied()
            .map(char::from_u32)
            .collect::<Option<String>>()
            .ok_or(ImageDataError::Json)?;
        Ok(Self {
            container_name,
            company_root: MetadataText::from_text(root.clone()),
        })
    }
    pub fn container_name(&self) -> &str {
        &self.container_name
    }
    pub fn company_root(&self) -> &MetadataText {
        &self.company_root
    }
}
#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::storage_identity::decode_ordered_metadata;
    #[test]
    fn deployment_projection_preserves_lossless_path_and_unknown_owner_fields() {
        let raw=decode_ordered_metadata(br#"{"version":1,"containerName":"office","companyRoot":"/private/\ud800","other":{"selected":true}}"#).unwrap();
        let value = DeploymentCompanyData::capture(&raw).unwrap();
        assert_eq!(value.container_name(), "office");
        assert_eq!(value.company_root().codepoints().last(), Some(&0xd800));
    }
    #[test]
    fn deployment_projection_rejects_noninteger_version_and_nontext_fields() {
        for raw in [
            r#"{"version":true,"containerName":"office","companyRoot":"/private"}"#,
            r#"{"version":1.0,"containerName":"office","companyRoot":"/private"}"#,
            r#"{"version":2,"containerName":"office","companyRoot":"/private"}"#,
            r#"{"version":1,"containerName":42,"companyRoot":"/private"}"#,
            r#"{"version":1,"containerName":"office","companyRoot":false}"#,
        ] {
            assert!(
                DeploymentCompanyData::capture(&decode_ordered_metadata(raw.as_bytes()).unwrap())
                    .is_err()
            );
        }
    }
}
