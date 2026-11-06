//! Target path DATA only. The application selects these from actual installed
//! control/operation owners; path declarations never provide effect authority.
use super::*;
pub struct CustodyPaths {
    root: PosixPath,
    binding: PosixPath,
    pending: PosixPath,
}
impl CustodyPaths {
    pub fn control(config: &ReservationConfiguration) -> Result<Self> {
        let paths = config.control_paths()?;
        Ok(Self {
            root: paths.root().clone(),
            binding: paths.binding().clone(),
            pending: paths.pending().clone(),
        })
    }
    pub fn declared(root: PosixPath, binding: PosixPath) -> Result<Self> {
        let points = binding.codepoints();
        let name = points
            .rsplit(|&point| point == 47)
            .next()
            .unwrap_or_default();
        need(!name.is_empty() && name != [46], "RESERVATION_CONTROL_PATH")?;
        // Python3.13 Path.with_suffix('.pending'): a trailing dot has no
        // suffix; a leading dot alone is part of the filename.
        let end = name
            .iter()
            .rposition(|&point| point == 46)
            .filter(|&index| index > 0 && index + 1 < name.len())
            .unwrap_or(name.len());
        let mut next = name[..end].to_vec();
        next.extend(".pending".chars().map(u32::from));
        let pending = binding.parent().join(
            &PosixPath::try_new(&next)
                .map_err(|_| ReservationKernelError::Refused("RESERVATION_CONTROL_PATH"))?,
        );
        Ok(Self {
            root,
            binding,
            pending,
        })
    }
    pub fn current_image(
        config: &ReservationConfiguration,
        image: &crate::reservation_control::CurrentImageBinding,
    ) -> Result<Self> {
        let binding = PosixPath::try_new(&native::python_text(image.path()))
            .map_err(|_| ReservationKernelError::Refused("RESERVATION_CONTROL_PATH"))?;
        Self::declared(config.control_paths()?.root().clone(), binding)
    }
    pub fn prepared_policy(policy: &crate::reservation_control::PolicyBinding) -> Result<Self> {
        let binding = PosixPath::try_new(&native::python_text(policy.path()))
            .map_err(|_| ReservationKernelError::Refused("RESERVATION_CONTROL_PATH"))?;
        Self::declared(binding.parent(), binding)
    }
    pub fn paths(&self) -> [&PosixPath; 3] {
        [&self.root, &self.binding, &self.pending]
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[derive(serde::Deserialize)]
    struct Case {
        source: Vec<u32>,
        expected: Option<Vec<u32>>,
    }
    #[test]
    fn exact_python_pending_suffix_preserves_hidden_dot_parent_and_codepoints() {
        let cases: Vec<Case> = serde_json::from_str(include_str!(
            "../../tests/fixtures/reservation-custody-suffix-python.json"
        ))
        .unwrap();
        assert_eq!(cases.len(), 16);
        for case in cases {
            let result = CustodyPaths::declared(
                path("/owned/control"),
                PosixPath::try_new(&case.source).unwrap(),
            );
            assert_eq!(
                result.ok().map(|value| value.pending.codepoints()),
                case.expected,
                "{:?}",
                case.source
            );
        }
    }
}
