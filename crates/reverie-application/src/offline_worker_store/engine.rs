use super::{Config, QualifiedTarget, ReadEngine, Result, Roots, Seat, observe};
use crate::worker_validation::ValidatedWorkerSnapshot;
use reverie_contracts::{
    rootless::{RootlessConfig, RootlessImage},
    storage_identity::MetadataText,
    worker_image_switch::WorkerImageId,
    worker_nix::{
        image_has_user, image_supports_private_store,
        offline_qualification::{Target, engine, mounts::planned_binds},
    },
};
use reverie_core::ids::ContainerId;
use reverie_host::{
    rootless,
    worker_nix::{offline_qualification::mount_custody, offline_store_engine::Query},
};
use serde_json::value::RawValue;
use std::path::{Path, PathBuf};

pub(super) fn validate(
    config: &ValidatedWorkerSnapshot,
    target: &Target,
    roots: &Roots,
    read: ReadEngine<'_>,
) -> Result<()> {
    let socket = target.engine_socket();
    let observed_identity: String = serde_json::from_slice(&read(socket, Query::Identity)?)?;
    if observed_identity != target.engine_id() {
        return Err("validated engine identity changed".into());
    }
    let base = config.envelope().base();
    if base.image() != target.image_id() {
        return Err("validated target must already be selected for normal next start".into());
    }
    let image_id = WorkerImageId::parse(target.image_id())?;
    let image = read(socket, Query::Image(image_id.clone()))?;
    engine::check_image(&image, &image_id)?;
    let image_view = RootlessImage::decode_inspection(
        &image,
        &MetadataText::from_scalar_text(target.image_id()),
    )?;
    rootless::require_rootless_image(
        &RootlessConfig::capture(config.configuration().clone())?,
        &image_view,
    )?;
    let ids = base.ids();
    if !image_has_user(&image, ids.uid(), ids.gid())? || !image_supports_private_store(&image)? {
        return Err("reviewed owner Nix image required".into());
    }
    let bytes = validation_container(target, &image_id, read)?;
    if target.needs_isolated_image() {
        let protected = roots
            .storage_sources()
            .into_iter()
            .chain([
                roots.office_socket.clone(),
                roots.broker_socket.clone(),
                socket.to_owned(),
            ])
            .collect::<Vec<_>>();
        mount_custody::isolated_image(&protected, &bytes, ids.uid(), ids.gid())?;
    }
    Ok(())
}

fn validation_container(
    target: &Target,
    image: &WorkerImageId,
    read: ReadEngine<'_>,
) -> Result<Vec<u8>> {
    let socket = target.engine_socket();
    let cid = ContainerId::parse(target.validation_container_id())?;
    let raw = read(socket, Query::Inspect(vec![cid.clone()]))?;
    let rows: Vec<&RawValue> = serde_json::from_slice(&raw)?;
    let [row] = rows.as_slice() else {
        return Err("qualified image base changed".into());
    };
    let bytes = row.get().as_bytes();
    engine::check_validation_image(bytes, &cid, image)?;
    let base: String = serde_json::from_slice(&read(socket, Query::Base(cid))?)?;
    if base != target.base_target() {
        return Err("qualified image base changed".into());
    }
    Ok(bytes.to_vec())
}

pub(super) fn custody(
    config: &Config,
    target: &QualifiedTarget,
    seat: &Seat,
    private_inputs: [&Path; 2],
    read: ReadEngine<'_>,
) -> Result<Vec<String>> {
    let socket = target.target.engine_socket();
    let ids: Vec<String> = serde_json::from_slice(&read(socket, Query::Inventory)?)?;
    let mut binds = Vec::new();
    let mut retained = Vec::new();
    let helper_name = format!(
        "/{}",
        seat.helper
            .name()
            .scalar_text()
            .ok_or("invalid helper name")?
    );
    let stores = [seat.paths.home().to_owned(), seat.paths.nix().to_owned()];
    let stores_text = stores.each_ref().map(|path| observe::path_text(path));
    for batch in ids.chunks(32) {
        let ids = batch
            .iter()
            .map(|id| ContainerId::parse(id))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let raw = read(socket, Query::Inspect(ids.clone()))?;
        engine::check_batch(&raw, &ids)?;
        let data = planned_binds(
            &raw,
            &helper_name,
            stores_text.each_ref().map(Vec::as_slice),
        )?;
        retained.extend(data.retained_ids);
        binds.extend(data.binds);
    }
    retained.sort_unstable();
    let controls = private_inputs
        .into_iter()
        .map(Path::to_owned)
        .chain([
            seat.locks
                .lock()
                .parent()
                .ok_or("lock has no directory")?
                .to_owned(),
            config.roots.audit_directory(),
        ])
        .chain(target.evidence_paths.iter().cloned())
        .collect::<Vec<_>>();
    let future = future_sources(config)?;
    mount_custody::plan(&controls, &stores, &future, &binds)?;
    Ok(retained)
}

fn future_sources(config: &Config) -> Result<Vec<PathBuf>> {
    let mut paths = config
        .worker
        .envelope()
        .mounts()
        .iter()
        .map(|mount| observe::path(mount.source()))
        .collect::<std::io::Result<Vec<_>>>()?;
    // Preserve future account and employee-source protection before any
    // corresponding laptop container or private store exists.
    paths.extend(config.roots.storage_sources());
    Ok(paths)
}
