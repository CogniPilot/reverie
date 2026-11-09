use super::*;
use std::{
    cell::RefCell,
    os::unix::fs::{MetadataExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};
#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum Point {
    Prepared,
    WriterClosed,
    BeforeCas,
    Renamed,
}
type Hook = Box<dyn FnOnce(&Path, &OsStr) -> Result<()>>;
thread_local! {static HOOKS:RefCell<Vec<(Point,Hook)>>=RefCell::default();}
pub(super) fn hit(point: Point, parent: &Path, name: &OsStr) -> Result<()> {
    let hook = HOOKS.with(|hooks| {
        let mut hooks = hooks.borrow_mut();
        hooks
            .iter()
            .position(|(selected, _)| *selected == point)
            .map(|index| hooks.remove(index).1)
    });
    hook.map_or(Ok(()), |hook| hook(parent, name))
}
pub(super) fn hook(point: Point, body: impl FnOnce(&Path, &OsStr) -> Result<()> + 'static) {
    HOOKS.with(|hooks| hooks.borrow_mut().push((point, Box::new(body))));
}
pub(super) fn clear() {
    HOOKS.with(|hooks| hooks.borrow_mut().clear());
}
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "gpu-private-files-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }
    fn files(&self, path: &Path) -> GpuControlFiles {
        let raw=serde_json::to_vec(&serde_json::json!({"uid":fs::metadata(&self.0).unwrap().uid(),"stateRoot":self.0,"resourceReservations":{"directory":self.0}})).unwrap();
        GpuControlFiles::capture(
            path,
            &reverie_contracts::worker_config::decode(&raw).unwrap(),
        )
    }
    fn references(&self) -> usize {
        fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| fs::read_link(entry.ok()?.path()).ok())
            .filter(|path| path.starts_with(&self.0))
            .count()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        HOOKS.with(|hooks| hooks.borrow_mut().clear());
        native::test_faults::set(None, false);
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn real_private_metadata_refuses_aliases_links_modes_and_fifo_before_read() {
    let tree = Tree::new();
    let path = tree.write("config", b"{}");
    let files = tree.files(&path);
    assert!(files.read_configuration().is_ok());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    assert_eq!(
        files.read_configuration().err().unwrap().code(),
        "GPU_PRIVATE_FILE"
    );
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::hard_link(&path, tree.0.join("alias")).unwrap();
    assert!(files.read_configuration().is_err());
    fs::remove_file(tree.0.join("alias")).unwrap();
    symlink(&path, tree.0.join("link")).unwrap();
    assert!(
        tree.files(&tree.0.join("link"))
            .read_configuration()
            .is_err()
    );
    let fifo = tree.0.join("fifo");
    nix::unistd::mkfifo(
        &fifo,
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    assert_eq!(
        tree.files(&fifo).read_configuration().err().unwrap().code(),
        "GPU_PRIVATE_FILE"
    );
    assert_eq!(tree.references(), 0);
}
#[test]
fn anchored_target_cas_preserves_concurrent_target_and_failed_candidate() {
    let tree = Tree::new();
    let path = tree.write("queue", b"before");
    let expected = GpuFileStamp::observe(&path).unwrap();
    hook(Point::BeforeCas, |parent, _| {
        fs::rename(parent.join("queue"), parent.join("original"))?;
        fs::write(parent.join("queue"), b"foreign")?;
        Ok(())
    });
    assert_eq!(
        replace(&path, b"after", Some(&expected))
            .unwrap_err()
            .code(),
        "GPU_FILE_CAS_CHANGED"
    );
    assert_eq!(fs::read(&path).unwrap(), b"foreign");
    assert_eq!(fs::read(tree.0.join("original")).unwrap(), b"before");
    assert_eq!(
        fs::read_dir(&tree.0)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry
                .file_name()
                .as_encoded_bytes()
                .starts_with(b"queue.gpu-"))
            .count(),
        1
    );
    assert_eq!(tree.references(), 0);
}
#[test]
fn pinned_candidate_swap_edit_link_and_permissions_never_publish_foreign_data() {
    for fault in 0..4 {
        let tree = Tree::new();
        let path = tree.write("queue", b"before");
        let expected = GpuFileStamp::observe(&path).unwrap();
        hook(Point::BeforeCas, move |parent, name| {
            let path = parent.join(name);
            match fault {
                0 => {
                    fs::rename(&path, parent.join("owned-prepared"))?;
                    fs::write(&path, b"foreign")?;
                }
                1 => fs::write(path, b"edited")?,
                2 => fs::hard_link(path, parent.join("foreign-link"))?,
                _ => fs::set_permissions(path, fs::Permissions::from_mode(0o644))?,
            }
            Ok(())
        });
        assert_eq!(
            replace(&path, b"after", Some(&expected))
                .unwrap_err()
                .code(),
            "GPU_PREPARED_FILE_CHANGED"
        );
        assert_eq!(fs::read(&path).unwrap(), b"before");
        assert_eq!(tree.references(), 0);
        if fault == 0 {
            assert!(
                fs::read_dir(&tree.0)
                    .unwrap()
                    .filter_map(|entry| entry.ok())
                    .any(|entry| fs::read(entry.path()).is_ok_and(|raw| raw == b"foreign"))
            );
        }
    }
}
#[test]
fn actual_writer_and_anchor_close_errors_preserve_both_finalizers_without_retry() {
    let tree = Tree::new();
    let path = tree.write("queue", b"before");
    let expected = GpuFileStamp::observe(&path).unwrap();
    hook(Point::Prepared, |_, _| {
        native::test_faults::set(None, true);
        Ok(())
    });
    hook(Point::WriterClosed, |_, _| {
        native::test_faults::set(None, true);
        Ok(())
    });
    assert!(matches!(
        replace(&path, b"after", Some(&expected)),
        Err(GpuHostError::Finalized { .. })
    ));
    assert_eq!(fs::read(path).unwrap(), b"before");
    assert_eq!(tree.references(), 0);
}
#[test]
fn lost_rename_ack_and_post_rename_close_refuse_without_restoring_committed_bytes() {
    for close in [false, true] {
        let tree = Tree::new();
        let path = tree.write("queue", b"before");
        let expected = GpuFileStamp::observe(&path).unwrap();
        hook(Point::Renamed, move |_, _| {
            if close {
                native::test_faults::set(None, true);
                Ok(())
            } else {
                Err(io::Error::other("owned lost rename acknowledgement").into())
            }
        });
        let error = replace(&path, b"after", Some(&expected)).unwrap_err();
        assert!(error.is_uncertain());
        assert_eq!(fs::read(path).unwrap(), b"after");
        assert_eq!(tree.references(), 0);
    }
}
#[test]
fn replacing_parent_before_commit_keeps_old_candidate_and_new_parent_untouched() {
    let tree = Tree::new();
    let parent = tree.0.join("nested");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("queue");
    fs::write(&path, b"before").unwrap();
    let expected = GpuFileStamp::observe(&path).unwrap();
    hook(Point::BeforeCas, |parent, _| {
        fs::rename(parent, parent.with_file_name("original-parent"))?;
        fs::create_dir(parent)?;
        fs::write(parent.join("queue"), b"foreign")?;
        Ok(())
    });
    assert_eq!(
        replace(&path, b"after", Some(&expected))
            .unwrap_err()
            .code(),
        "GPU_PARENT_CUSTODY_CHANGED"
    );
    assert_eq!(fs::read(path).unwrap(), b"foreign");
    assert_eq!(
        fs::read(tree.0.join("original-parent/queue")).unwrap(),
        b"before"
    );
    assert_eq!(tree.references(), 0);
}
