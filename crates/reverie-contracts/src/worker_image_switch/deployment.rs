//! The existing deployment/company projection. Native registered path, parent,
//! directory and lock custody are separate observations.
#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::storage_identity::decode_ordered_metadata;
    #[test]
    fn deployment_projection_preserves_lossless_path_and_unknown_owner_fields() {
        let raw=decode_ordered_metadata(br#"{"version":1,"containerName":"office","companyRoot":"/private/\ud800","other":{"selected":true}}"#).unwrap();
        let value=DeploymentCompanyData::capture(&raw).unwrap();
        assert_eq!(value.container_name(),"office");
        assert_eq!(value.company_root().codepoints().last(),Some(&0xd800));
    }
    #[test]
    fn deployment_projection_rejects_noninteger_version_and_nontext_fields() {
        for raw in [r#"{"version":true,"containerName":"office","companyRoot":"/private"}"#,r#"{"version":1.0,"containerName":"office","companyRoot":"/private"}"#,r#"{"version":2,"containerName":"office","companyRoot":"/private"}"#,r#"{"version":1,"containerName":42,"companyRoot":"/private"}"#,r#"{"version":1,"containerName":"office","companyRoot":false}"#] {assert!(DeploymentCompanyData::capture(&decode_ordered_metadata(raw.as_bytes()).unwrap()).is_err());}
    }
}
