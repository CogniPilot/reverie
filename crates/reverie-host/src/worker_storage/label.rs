//! Fixed scratch metadata through actual lifetime storage resources.
use super::*;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LabelDisposition {
    Created,
    Preserved,
}
pub(super) fn write(
    config: &Configuration,
    paths: &StoragePaths,
    effects: &mut bool,
) -> Result<LabelDisposition> {
    let directory = Directory::open(paths.scratch(), config.uid())?;
    let result = directory.write_scratch_label(paths, effects);
    finalized(result, directory.close())
}
impl StorageLease {
    pub fn write_scratch_label(&mut self) -> Result<LabelDisposition> {
        self.assert_current()?;
        let mut effects = false;
        let result = write(&self.config, &self.paths, &mut effects);
        partial(finalized(result, self.assert_current()), effects)
    }
}
