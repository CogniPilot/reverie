//! Pure decoder role. It does not construct any controller host owner.
use reverie_contracts::worker_pool::ControllerBirthCheck;
use std::io::{Read, Write};

pub(super) fn run(input: impl Read, mut output: impl Write) -> Result<(), &'static str> {
    let mut raw = Vec::new();
    input
        .take(65_537)
        .read_to_end(&mut raw)
        .map_err(|_| "WORKER_POOL_BIRTH_CHECK_INPUT")?;
    let checked =
        ControllerBirthCheck::from_birth(&raw).map_err(|_| "WORKER_POOL_BIRTH_CHECK_INVALID")?;
    let encoded = checked
        .encode()
        .map_err(|_| "WORKER_POOL_BIRTH_CHECK_ENCODING")?;
    output
        .write_all(&encoded)
        .and_then(|()| output.flush())
        .map_err(|_| "WORKER_POOL_BIRTH_CHECK_OUTPUT")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_or_oversized_birth_has_no_success_output_or_host_initialization() {
        for raw in [b"{}".to_vec(), vec![b' '; 65_537]] {
            let mut output = Vec::new();
            assert_eq!(
                run(raw.as_slice(), &mut output),
                Err("WORKER_POOL_BIRTH_CHECK_INVALID")
            );
            assert!(output.is_empty());
        }
    }
}
