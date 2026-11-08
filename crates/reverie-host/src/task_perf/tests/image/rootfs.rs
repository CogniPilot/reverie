//! Fixed empty native-workload rootfs: directories only, no scripts or command
//! payload. The declared immutable Coreutils closure supplies the sole program.
use std::{fs::File, io::Write, path::Path};

pub(super) fn create(path: &Path) {
    let mut file = File::options()
        .write(true)
        .create_new(true)
        .open(path)
        .unwrap();
    for name in ["nix/", "nix/store/", "tmp/"] {
        let mut header = [0u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        octal(&mut header[100..108], 0o755);
        for range in [108..116, 116..124, 124..136, 136..148] {
            octal(&mut header[range], 0);
        }
        header[148..156].fill(b' ');
        header[156] = b'5';
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        let sum: u64 = header.iter().map(|byte| u64::from(*byte)).sum();
        octal(&mut header[148..156], sum);
        file.write_all(&header).unwrap();
    }
    file.write_all(&[0u8; 1024]).unwrap();
    file.sync_all().unwrap();
    crate::native::close(file).unwrap();
}
fn octal(field: &mut [u8], value: u64) {
    let text = format!("{value:0width$o}", width = field.len() - 1);
    assert_eq!(text.len() + 1, field.len());
    field[..text.len()].copy_from_slice(text.as_bytes());
}
