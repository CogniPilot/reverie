use super::*;
use std::collections::BTreeSet;

impl PreflightLaptop {
    pub fn require_capabilities(&self, rootless: bool) -> Result<()> {
        let host = self.host()?;
        let caps = required(host, "CapAdd")?;
        let values = match &caps.0 {
            Node::Null => &[][..],
            Node::Array(values) => values.as_slice(),
            _ => return Err(GpuDataError::NativeBinding),
        };
        let mut actual = BTreeSet::new();
        for cap in values {
            let value = text(cap).ok_or(GpuDataError::NativeBinding)?;
            actual.insert(value.strip_prefix("CAP_").unwrap_or(&value).to_owned());
        }
        let expected: BTreeSet<_> = if rootless {
            ["SETUID", "SETGID"]
                .into_iter()
                .map(str::to_owned)
                .collect()
        } else {
            BTreeSet::new()
        };
        let drop = Value(Node::Array(vec![string("ALL")]));
        let private = field(host, "PidMode").is_some_and(|value| {
            value.python_eq(&string("")) || value.python_eq(&string("private"))
        });
        if actual != expected
            || !required(host, "CapDrop")?.python_eq(&drop)
            || !matches!(field(host, "Privileged"), Some(Value(Node::Bool(false))))
            || !private
        {
            return Err(GpuDataError::NativeBinding);
        }
        Ok(())
    }
}
