use super::TemporaryEnvironmentRoot;
use crate::PythonText;
const SHIM: &str = "/opt/reverie/autoenv/bin";
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChildEnvironmentValue {
    Text(PythonText),
    Other,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChildEnvironmentError;
impl std::fmt::Display for ChildEnvironmentError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("CHILD_PATH_TYPE")
    }
}
impl std::error::Error for ChildEnvironmentError {}
/// Dict merge order is retained. Nontext JSON values survive until either a
/// fixed override removes them or the native exec-environment encoder refuses.
#[derive(Clone)]
pub struct ChildEnvironment {
    entries: Vec<(PythonText, ChildEnvironmentValue)>,
    index: std::collections::BTreeMap<PythonText, usize>,
}
impl ChildEnvironment {
    pub fn prepare(
        inherited: Vec<(PythonText, PythonText)>,
        requested: Vec<(PythonText, ChildEnvironmentValue)>,
        temporary: &TemporaryEnvironmentRoot,
        packaged_shim: bool,
    ) -> Result<Self, ChildEnvironmentError> {
        let explicit_target = requested
            .iter()
            .any(|(key, _)| key.equals_ascii("CARGO_TARGET_DIR"));
        let mut env = Self {
            entries: Vec::new(),
            index: std::collections::BTreeMap::new(),
        };
        for (key, value) in inherited {
            env.set(key, ChildEnvironmentValue::Text(value));
        }
        for (key, value) in requested {
            env.set(key, value);
        }
        env.fixed("REVERIE_WORKER", "1");
        env.fixed("REVERIE_INSTALL_CLIS", "none");
        for (key, value) in temporary.entries() {
            env.fixed(&key, &value);
        }
        env.remove("REVERIE_WORKER_SOCKET");
        if !explicit_target
            && matches!(env.get("CARGO_TARGET_DIR"),Some(ChildEnvironmentValue::Text(value)) if value.equals_ascii("/tmp/reverie/build/cargo"))
        {
            env.remove("CARGO_TARGET_DIR");
        }
        if packaged_shim {
            env.prepend_shim()?;
        }
        Ok(env)
    }
    pub fn entries(&self) -> &[(PythonText, ChildEnvironmentValue)] {
        &self.entries
    }
    pub fn for_model_relay(&self) -> Self {
        let mut result = self.clone();
        result.fixed("REVERIE_MODEL_SOCKET", "/run/reverie-model/default.sock");
        result
    }
    fn get(&self, key: &str) -> Option<&ChildEnvironmentValue> {
        self.index
            .get(&PythonText::from_scalar_text(key))
            .map(|&index| &self.entries[index].1)
    }
    fn remove(&mut self, key: &str) {
        self.entries.retain(|(name, _)| !name.equals_ascii(key));
        self.index = self
            .entries
            .iter()
            .enumerate()
            .map(|(index, (key, _))| (key.clone(), index))
            .collect();
    }
    fn set(&mut self, key: PythonText, value: ChildEnvironmentValue) {
        if let Some(&index) = self.index.get(&key) {
            self.entries[index].1 = value;
        } else {
            self.index.insert(key.clone(), self.entries.len());
            self.entries.push((key, value));
        }
    }
    fn fixed(&mut self, key: &str, value: &str) {
        self.set(
            PythonText::from_scalar_text(key),
            ChildEnvironmentValue::Text(PythonText::from_scalar_text(value)),
        );
    }
    fn prepend_shim(&mut self) -> Result<(), ChildEnvironmentError> {
        let fallback = PythonText::from_scalar_text("/bin");
        let value = match self.get("PATH") {
            None => &fallback,
            Some(ChildEnvironmentValue::Text(value)) => value,
            Some(ChildEnvironmentValue::Other) => return Err(ChildEnvironmentError),
        };
        let shim = PythonText::from_scalar_text(SHIM);
        let mut path = shim.codepoints().to_vec();
        for entry in value
            .codepoints()
            .split(|&point| point == 58)
            .filter(|entry| *entry != shim.codepoints())
        {
            path.push(58);
            path.extend_from_slice(entry);
        }
        self.set(
            PythonText::from_scalar_text("PATH"),
            ChildEnvironmentValue::Text(
                PythonText::try_new(path).expect("composed checked codepoints"),
            ),
        );
        Ok(())
    }
}
