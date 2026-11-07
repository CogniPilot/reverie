//! Private one-shot fault points after real effects/finalizers. No production
//! environment selector, permission callback, or alternate file producer.
use super::*;
use std::cell::RefCell;
#[derive(Clone, Copy, Eq, PartialEq)]
pub(in crate::reservation_gate::gpu_access) enum Point {
    BeforePending,
    ConfigWritten,
    RamPublished,
    AdmissionClosed,
    BeforeRelease,
}
#[derive(Clone, Copy)]
pub(super) enum Action {
    ForeignBinding,
    ChangedCdi,
    LostCloseAcknowledgement,
    ForeignPending,
}
thread_local! {static FAULT:RefCell<Option<(Point,Action)>>=const {RefCell::new(None)};}
pub(super) fn arm(point: Point, action: Action) {
    FAULT.with(|slot| assert!(slot.borrow_mut().replace((point, action)).is_none()));
}
pub(in crate::reservation_gate::gpu_access) fn at(
    point: Point,
    record: &TransitionRecord,
) -> Result<()> {
    let action = FAULT.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot
            .as_ref()
            .is_some_and(|(selected, _)| *selected == point)
        {
            slot.take().map(|(_, action)| action)
        } else {
            None
        }
    });
    let Some(action) = action else {
        return Ok(());
    };
    let source = record.before.source_path().unwrap();
    let root = source.parent().unwrap();
    match action {
        Action::ForeignBinding => fs::write(
            root.join("state/resource-reservation-control.json"),
            b"foreign binding",
        )
        .unwrap(),
        Action::ChangedCdi => fs::write(
            root.join("cdi/device.json"),
            b"unparsed changed specification",
        )
        .unwrap(),
        Action::LostCloseAcknowledgement => {
            return Err(GateError::Refused("OWNED_ADMISSION_CLOSE_ACK_LOST"));
        }
        Action::ForeignPending => fs::write(
            root.join("state/resource-reservation-control.pending"),
            b"foreign pending",
        )
        .unwrap(),
    }
    Ok(())
}
