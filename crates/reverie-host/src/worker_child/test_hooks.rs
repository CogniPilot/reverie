//! Private fault ordering only; never compiled into a product interface.
use super::error::Result;
use std::cell::RefCell;
#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum Point {
    Read,
    BeforeUnlink,
    AfterUnlink,
    BeforePublish,
    AfterPublish,
}
type Hook = Box<dyn FnMut(Point) -> Result<()>>;
thread_local! {static HOOK:RefCell<Option<Hook>>=RefCell::new(None);}
pub(super) struct Guard;
impl Drop for Guard {
    fn drop(&mut self) {
        HOOK.with(|value| *value.borrow_mut() = None);
    }
}
pub(super) fn set(hook: Hook) -> Guard {
    HOOK.with(|value| *value.borrow_mut() = Some(hook));
    Guard
}
pub(super) fn run(point: Point) -> Result<()> {
    HOOK.with(|value| {
        if let Some(hook) = value.borrow_mut().as_mut() {
            hook(point)
        } else {
            Ok(())
        }
    })
}
