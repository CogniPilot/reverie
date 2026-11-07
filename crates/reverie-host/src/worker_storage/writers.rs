//! Exact running-only writer observation, on the runtime's existing client.
//! Successful census is current DATA; it is not permanent writer exclusivity.
use super::*;
use crate::{
    captured_client::Policy,
    engine_metadata::{CancellationToken, EngineError, MAX_OUTPUT_BYTES, MAX_QUERY_SECONDS},
    worker_runtime::WorkerRuntime,
};
use reverie_contracts::{
    reservation_engine::StorageIdentityRef,
    storage_writers::{WriterIds, WriterInventory, WriterSelection},
};
use std::{
    ffi::OsString,
    time::{Duration, Instant},
};
type Result<T> = std::result::Result<T, StorageOwnerError>;
impl WorkerRuntime {
    pub fn check_selected_storage_writers(
        &self,
        selection: &StorageSelection,
        deadline: Option<Instant>,
    ) -> Result<()> {
        selection.assert_runtime(self)?;
        observe(
            self,
            selection.source_configuration(),
            selection.paths(),
            deadline,
        )
    }
    pub fn check_storage_writers(
        &self,
        storage: &LaunchStorage,
        deadline: Option<Instant>,
    ) -> Result<()> {
        storage.assert_binding(
            self,
            storage.source_configuration(),
            storage.paths().session(),
        )?;
        observe(
            self,
            storage.source_configuration(),
            storage.paths(),
            deadline,
        )
    }
}
fn query(
    runtime: &WorkerRuntime,
    args: Vec<OsString>,
    deadline: Option<Instant>,
) -> Result<Vec<u8>> {
    let maximum = Duration::from_secs(MAX_QUERY_SECONDS);
    let mut end = deadline.map_or(Instant::now() + maximum, |end| {
        end.min(Instant::now() + maximum)
    });
    if let Some(stop) = runtime.stop_deadline() {
        end = end.min(stop);
    }
    let output = runtime
        .installed_engine()
        .readonly()
        .client
        .run(
            args,
            end,
            &CancellationToken::new(),
            Policy {
                maximum,
                maximum_output: MAX_OUTPUT_BYTES,
                successful_exit: true,
            },
        )
        .map_err(EngineError::from)
        .map_err(StorageOwnerError::Engine)?;
    // Inspect/ps remain allowed during stop; only their original shared budget
    // applies. A launch cancellation token must not prohibit cleanup metadata.
    Ok(output.stdout)
}
fn observe(
    runtime: &WorkerRuntime,
    source: &EffectiveWorkerConfig,
    paths: &StoragePaths,
    deadline: Option<Instant>,
) -> Result<()> {
    let raw = query(
        runtime,
        ["ps", "--quiet", "--no-trunc"].map(OsString::from).to_vec(),
        deadline,
    )?;
    let text = std::str::from_utf8(&raw)
        .map_err(|_| StorageOwnerError::Refused("WORKER_STORAGE_WRITER_ENCODING"))?;
    let ids = WriterIds::decode(text).map_err(StorageOwnerError::Data)?;
    if ids.is_empty() {
        return Ok(());
    }
    let mut args = vec![OsString::from("inspect")];
    args.extend(ids.ids().iter().map(|id| OsString::from(id.as_str())));
    let raw = query(runtime, args, deadline)?;
    let rows = WriterInventory::decode(&raw, &ids).map_err(StorageOwnerError::Data)?;
    let identity = paths.employee().map_or_else(
        || StorageIdentityRef::Session(paths.session()),
        StorageIdentityRef::Employee,
    );
    let text = StorageConfiguration::capture(source)
        .storage_path_text(identity)
        .map_err(|error| StorageOwnerError::Storage(StorageError::PathText(error)))?;
    if native::python_path(&text.home().codepoints()).map_err(StorageOwnerError::Path)?
        != paths.home()
        || native::python_path(&text.nix().codepoints()).map_err(StorageOwnerError::Path)?
            != paths.nix()
    {
        return Err(StorageOwnerError::Refused(
            "WORKER_STORAGE_PATH_TEXT_BINDING",
        ));
    }
    let selected = WriterSelection {
        deployment: runtime.worker_identity().deployment(),
        session: paths.session(),
        identity: paths.identity(),
        paths: &text,
    };
    for index in 0..rows.len() {
        let row = rows.row(index, selected).map_err(StorageOwnerError::Data)?;
        for mount in row.mounts() {
            let source = mount.source().map_err(StorageOwnerError::Data)?;
            let resolved = native::resolve_optional_text(source.codepoints())
                .map_err(StorageOwnerError::Path)?;
            mount
                .check_resolved(&resolved)
                .map_err(StorageOwnerError::Data)?;
        }
    }
    Ok(())
}
