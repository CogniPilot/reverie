//! Synthetic kernel mount tables only. No mount is created or removed.
use super::*;

const SOURCE: &str = "/home/owner/office/instance";
const OPERATION: &str = "/home/owner/office/runtime/update-state/console-deployments/op";
const REHEARSAL: &str = "/mnt/scratch/rehearsal/op";

/// A workstation with one console data disk, one scratch disk and a few
/// containers. Fields follow /proc/self/mountinfo.
const BASE: &[&str] = &[
    "66 1 259:4 / / rw,relatime - ext4 /dev/nvme0n1p2 rw",
    "39 66 0:34 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
    "43 66 259:4 /nix/store /nix/store ro,nosuid,nodev,relatime - ext4 /dev/nvme0n1p2 rw",
    "50 66 259:1 / /mnt/scratch rw,noatime - ext4 /dev/nvme1n1p1 rw",
    "69 66 0:26 / /run rw,nosuid,nodev - tmpfs tmpfs rw,mode=755",
    "700 69 0:4 net:[4026533001] /run/docker/netns/4651bfe6aa01 rw - nsfs nsfs rw",
    "701 66 0:90 / /var/lib/docker/rootfs/overlayfs/4651bfe6aa01 rw,relatime - overlay overlay rw",
    "702 66 0:91 / /tmp/containerd-mount1234 rw,relatime - overlay overlay rw",
];

fn table(rows: &[&str]) -> MountTable {
    let text = rows.join("\n");
    MountTable::parse(&text.chars().map(u32::from).collect::<Vec<_>>()).unwrap()
}
fn scope() -> Scope {
    let mut scope = Scope::fixed();
    for path in [SOURCE, OPERATION, REHEARSAL] {
        scope.include(Path::new(path)).unwrap();
    }
    scope
}
fn with(extra: &[&str]) -> MountTable {
    table(&[BASE, extra].concat())
}
fn replaced(id: &str, row: &str) -> MountTable {
    let prefix = format!("{id} ");
    let rows = BASE
        .iter()
        .copied()
        .map(|line| if line.starts_with(&prefix) { row } else { line })
        .collect::<Vec<_>>();
    assert!(rows.contains(&row), "fixture row {id} must exist");
    table(&rows)
}
fn without(id: &str) -> MountTable {
    let prefix = format!("{id} ");
    let rows = BASE
        .iter()
        .copied()
        .filter(|line| !line.starts_with(&prefix))
        .collect::<Vec<_>>();
    assert_eq!(rows.len() + 1, BASE.len(), "fixture row {id} must exist");
    table(&rows)
}

#[test]
fn other_containers_starting_and_exiting_leave_the_snapshot_mounts_unchanged() {
    let before = table(BASE);
    // The helper container exits, an image build finishes and two new
    // containers start: the journal of the two refused updates.
    let after = table(&[
        &BASE[..5],
        &[
            "810 69 0:4 net:[4026533777] /run/docker/netns/9d1de7c253b3 rw - nsfs nsfs rw",
            "811 66 0:97 / /var/lib/docker/rootfs/overlayfs/9d1de7c253b3 rw - overlay overlay rw",
            "812 66 0:98 / /var/lib/docker/rootfs/overlayfs/0f0f0f0f0f0f rw - overlay overlay rw",
            "813 69 0:55 / /run/user/1000 rw,nosuid,nodev - tmpfs tmpfs rw",
            "814 66 8:17 / /media/owner/usb rw - vfat /dev/sdb1 rw",
        ][..],
    ]
    .concat());
    assert_ne!(before, after);
    assert!(scope().unchanged(&before, &after));
    assert!(scope().unchanged(&after, &before));
}

#[test]
fn row_order_alone_is_not_a_change() {
    let mut reversed = BASE.to_vec();
    reversed.reverse();
    assert!(scope().unchanged(&table(BASE), &table(&reversed)));
}

#[test]
fn a_new_mount_on_or_inside_a_snapshot_path_is_a_change() {
    let before = table(BASE);
    for point in [
        SOURCE,
        "/home/owner/office/instance/console",
        "/home/owner/office/instance/console/accounts/profile",
        OPERATION,
        "/home/owner/office/runtime/update-state/console-deployments/op/snapshot",
        REHEARSAL,
        "/mnt/scratch/rehearsal/op/rehearsal/console",
    ] {
        let row = format!("900 66 0:99 / {point} rw - tmpfs tmpfs rw");
        assert!(!scope().unchanged(&before, &with(&[&row])), "{point}");
    }
}

#[test]
fn a_new_mount_above_a_snapshot_path_is_a_change() {
    let before = table(BASE);
    for point in [
        "/home",
        "/home/owner",
        "/home/owner/office",
        "/home/owner/office/runtime/update-state",
        "/mnt",
        "/mnt/scratch/rehearsal",
    ] {
        let row = format!("900 66 0:99 / {point} rw - tmpfs tmpfs rw");
        assert!(!scope().unchanged(&before, &with(&[&row])), "{point}");
    }
    // A second filesystem stacked on the same mount point hides the first.
    let stacked = "901 50 259:9 / /mnt/scratch rw - ext4 /dev/nvme2n1p1 rw";
    assert!(!scope().unchanged(&before, &with(&[stacked])));
}

#[test]
fn a_relevant_mount_changing_identity_device_root_or_type_is_a_change() {
    let before = table(BASE);
    for (id, row) in [
        // The scratch disk was unmounted and another device mounted there.
        (
            "50",
            "50 66 259:9 / /mnt/scratch rw,noatime - ext4 /dev/nvme2n1p1 rw",
        ),
        // The same device came back as a new mount.
        (
            "50",
            "950 66 259:1 / /mnt/scratch rw,noatime - ext4 /dev/nvme1n1p1 rw",
        ),
        // A different subtree of the same device is exposed there.
        (
            "50",
            "50 66 259:1 /other /mnt/scratch rw,noatime - ext4 /dev/nvme1n1p1 rw",
        ),
        (
            "50",
            "50 66 259:1 / /mnt/scratch rw,noatime - xfs /dev/nvme1n1p1 rw",
        ),
        // The mount now sits on a different parent mount.
        (
            "50",
            "50 69 259:1 / /mnt/scratch rw,noatime - ext4 /dev/nvme1n1p1 rw",
        ),
        ("66", "66 1 259:7 / / rw,relatime - ext4 /dev/nvme0n1p5 rw"),
    ] {
        assert!(!scope().unchanged(&before, &replaced(id, row)), "{row}");
    }
}

#[test]
fn a_relevant_mount_disappearing_is_a_change() {
    let before = table(BASE);
    for id in ["50", "39", "43"] {
        assert!(!scope().unchanged(&before, &without(id)), "{id}");
    }
}

#[test]
fn the_process_filesystem_and_tool_store_are_always_compared() {
    let before = table(BASE);
    for point in [
        "/proc/sys/fs/binfmt_misc",
        "/proc/4242",
        "/nix",
        "/nix/store/0000000000000000-tar/bin",
    ] {
        let row = format!("900 66 0:99 / {point} rw - tmpfs tmpfs rw");
        assert!(
            !Scope::fixed().unchanged(&before, &with(&[&row])),
            "{point}"
        );
    }
}

#[test]
fn a_sibling_that_only_shares_a_name_prefix_is_unrelated() {
    let before = table(BASE);
    for point in [
        "/home/owner/office/instance-old",
        "/home/owner/office-two",
        "/mnt/scratch-two",
        "/mnt/scratch/rehearsal/op-next",
        "/mnt/scratch/other",
        "/nix/store-old",
        "/process",
    ] {
        let row = format!("900 66 0:99 / {point} rw - tmpfs tmpfs rw");
        assert!(scope().unchanged(&before, &with(&[&row])), "{point}");
    }
}

#[test]
fn a_path_added_later_is_compared_against_the_first_table() {
    let before = table(BASE);
    let late = "/mnt/backup/console";
    let row = "900 66 259:8 / /mnt/backup rw - ext4 /dev/sdc1 rw";
    let after = with(&[row]);
    let mut scope = scope();
    assert!(scope.unchanged(&before, &after));
    scope.include(Path::new(late)).unwrap();
    assert!(!scope.unchanged(&before, &after));
}

#[test]
fn only_absolute_paths_can_join_the_scope() {
    let mut scope = Scope::fixed();
    for path in ["relative/path", "", "//network/root"] {
        assert_eq!(
            scope.include(Path::new(path)).unwrap_err().code(),
            "SNAPSHOT_MOUNT_PATH",
            "{path}"
        );
    }
}

#[test]
fn the_real_table_is_current_for_the_fixed_scope() {
    let end = Instant::now() + std::time::Duration::from_secs(30);
    let mut observed = Observed::capture(end).unwrap();
    observed.include(&std::env::temp_dir()).unwrap();
    observed.require_current(end).unwrap();
}
