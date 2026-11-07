//! Fault ports compiled only into owning-crate tests, never an API or feature.
use crate::error::{Result, StoreError};
use crate::private_fs::CloseRole;
use std::cell::RefCell;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Point {
    CreatedFilePermissions,
    InitialTemporaryMetadata,
    BeforeTemporaryPin,
    AfterDataRead,
    AfterTemporaryPrepared,
    AfterTemporaryCleanup,
    BeforePublication,
    BeforeRename,
    AfterRename,
    FileSync,
    DirectorySync,
    MemoryStartupBeforeWriter,
}
pub(crate) type Hook = Box<dyn FnMut(Point, &Path) -> Result<()>>;
#[derive(Default)]
pub(crate) struct State {
    pub(crate) hook: Option<Hook>,
    pub(crate) close: Option<CloseRole>,
    pub(crate) write_limit: Option<usize>,
    pub(crate) read_limit: Option<usize>,
    pub(crate) fail_write: bool,
}
pub(crate) fn read_limit(remaining: usize) -> usize {
    STATE.with(|state| {
        state
            .borrow()
            .read_limit
            .unwrap_or(remaining)
            .min(remaining)
    })
}
thread_local! {pub(crate) static STATE:RefCell<State>=RefCell::new(State::default());}
pub(crate) fn reset() {
    STATE.with(|state| *state.borrow_mut() = State::default());
}
pub(crate) fn hit(point: Point, path: &Path) -> Result<()> {
    let hook = STATE.with(|state| state.borrow_mut().hook.take());
    let Some(mut hook) = hook else {
        return Ok(());
    };
    let result = hook(point, path);
    STATE.with(|state| {
        if state.borrow().hook.is_none() {
            state.borrow_mut().hook = Some(hook);
        }
    });
    result
}
pub(crate) fn closed(role: CloseRole, _path: &Path) -> Result<()> {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        if state.close == Some(role) {
            state.close = None;
            Err(StoreError::io(std::io::Error::other(
                "injected close error after close",
            )))
        } else {
            Ok(())
        }
    })
}
pub(crate) fn write_limit(remaining: usize, _path: &Path) -> Result<usize> {
    STATE.with(|state| {
        let state = state.borrow();
        if state.fail_write {
            return Err(StoreError::io(std::io::Error::other(
                "injected write error",
            )));
        }
        Ok(state.write_limit.unwrap_or(remaining).min(remaining))
    })
}
