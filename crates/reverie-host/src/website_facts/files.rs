//! The same checked descriptor batch used by code and process observations.
use super::*;
use std::fs::File;
#[derive(Default)]
pub(super) struct Descriptors {
    files: Vec<File>,
    attempted: bool,
    uncertain: bool,
}
impl Descriptors {
    pub(super) fn retain(&mut self, file: File) -> usize {
        let index = self.files.len();
        self.files.push(file);
        index
    }
    pub(super) fn get(&self, index: usize) -> &File {
        &self.files[index]
    }
    pub(super) fn get_mut(&mut self, index: usize) -> &mut File {
        &mut self.files[index]
    }
    pub(super) fn close(&mut self) -> Result<()> {
        if !self.attempted {
            self.attempted = true;
            for file in self.files.drain(..).rev() {
                self.uncertain |= native::close(file).is_err();
            }
        }
        if self.uncertain {
            Err(WebsiteFactsError::DescriptorClose)
        } else {
            Ok(())
        }
    }
    pub(super) fn finish<T>(&mut self, body: Result<T>, uncertain: &mut bool) -> Result<T> {
        let closed = self.close();
        *uncertain |= closed.is_err();
        finalized(body, closed)
    }
}
impl Drop for Descriptors {
    fn drop(&mut self) {
        if !self.attempted {
            std::mem::forget(std::mem::take(&mut self.files));
        }
    }
}
pub(super) fn finalized<T>(body: Result<T>, cleanup: Result<()>) -> Result<T> {
    match (body, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(WebsiteFactsError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
