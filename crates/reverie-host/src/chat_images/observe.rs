use super::*;
use crate::office::OfficeImageBinding;
use reverie_contracts::{
    chat_images::{ImageNamespaceProjection, ImageStorageProjection, decode_inspection},
    resource_config::ResourceIdentitySettings,
    storage_identity::MetadataText,
    worker_config::EffectiveWorkerConfig,
    worker_schema::WorkerEnvelope,
};
use reverie_core::{
    decimal::UnsignedInteger, ids::ProfileSessionId, worker_laptop::WorkerContainerName,
};
use reverie_store::storage_identity::{StorageIdentityConfig, StorageKind, storage_start_allowed};
use std::time::Duration;
impl WorkerRuntime {
    pub fn observe_chat_image_namespace(
        &self,
        source: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> std::result::Result<ObservedImageNamespace, Box<ImageObservationFailure>> {
        capture(self, source, session, BindingPhase::Temporary)
    }
    pub fn observe_chat_image_cache_namespace(
        &self,
        source: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> std::result::Result<ObservedImageNamespace, Box<ImageObservationFailure>> {
        capture(self, source, session, BindingPhase::Cache)
    }
}
fn capture(
    runtime: &WorkerRuntime,
    source: &EffectiveWorkerConfig,
    session: &ProfileSessionId,
    phase: BindingPhase,
) -> std::result::Result<ObservedImageNamespace, Box<ImageObservationFailure>> {
    let mut query = QueryOwner {
        origin: runtime.installed_engine().clone(),
        pending: None,
    };
    observe(runtime, &mut query, source, session, phase)
        .map_err(|cause| Box::new(ImageObservationFailure { query, cause }))
}
fn allowed(source: &EffectiveWorkerConfig, selection: &StorageSelection) -> Result<()> {
    let settings = ResourceIdentitySettings::capture_worker_config(source)
        .map_err(|_| ImageObserveError::Refused("binding_changed"))?;
    let identity = StorageIdentityConfig::capture_worker_settings(&settings);
    need(
        selection.paths().kind() == StorageKind::Employee
            && storage_start_allowed(&identity, selection.paths())
                .map_err(|_| ImageObserveError::Refused("binding_changed"))?,
        "binding_changed",
    )
}
fn observe(
    runtime: &WorkerRuntime,
    query: &mut QueryOwner,
    source: &EffectiveWorkerConfig,
    session: &ProfileSessionId,
    phase: BindingPhase,
) -> Result<ObservedImageNamespace> {
    need(!runtime.cancellation().is_cancelled(), "laptop_unavailable")?;
    let selection = runtime
        .resolve_storage(source, session)
        .map_err(|error| ImageObserveError::Storage(Box::new(error)))?;
    allowed(source, &selection)?;
    let envelope = WorkerEnvelope::capture(source.clone())
        .map_err(|_| ImageObserveError::Refused("laptop_unavailable"))?;
    let name = WorkerContainerName::for_session(envelope.base(), session);
    let output = crate::worker_source_stop::captured_worker_cleanup(
        &query.origin,
        Instant::now() + Duration::from_secs(20),
        &mut query.pending,
        vec!["inspect".into(), name.as_str().into()],
        true,
    )
    .map_err(|error| ImageObserveError::Engine(Box::new(error)))?;
    let inspection = decode_inspection(
        std::str::from_utf8(&output.stdout)
            .map_err(|_| ImageObserveError::Refused("materialization_unavailable"))?,
        &name,
        runtime.worker_identity().deployment(),
        session,
        selection.paths().identity(),
        runtime.worker_identity().ids(),
    )
    .map_err(ImageObserveError::Data)?;
    isolation::attachments(&envelope, inspection.mounts())?;
    let temporary = selection.paths().scratch().join("tmp");
    isolation::storage(inspection.mounts(), selection.paths().root(), &temporary)?;
    let (start, identity) = namespace::observe(
        inspection.pid(),
        &temporary,
        matches!(phase, BindingPhase::Cache),
    )?;
    Ok(ObservedImageNamespace {
        selection,
        inspection,
        temporary,
        start,
        identity,
        phase,
    })
}
impl ObservedImageNamespace {
    pub fn bind_office(
        self,
        runtime: &WorkerRuntime,
        phone: &OfficeImageBinding,
        generation: &UnsignedInteger,
    ) -> Result<ObservedImageBinding> {
        self.selection
            .assert_runtime(runtime)
            .map_err(|error| ImageObserveError::Storage(Box::new(error)))?;
        need(
            phone.session() == self.selection.paths().session(),
            "office_unavailable",
        )?;
        let office = phone.identity(runtime).map_err(ImageObserveError::Office)?;
        let root = MetadataText::from_python_text(
            reverie_core::PythonText::try_new(crate::native::python_text(
                self.selection.paths().root(),
            ))
            .expect("filesystem text"),
        );
        let digest = self.inspection.projection(
            ImageStorageProjection {
                session: self.selection.paths().session(),
                employee: self.selection.paths().identity(),
                owner: self.selection.paths().owner(),
                root: &root,
            },
            ImageNamespaceProjection {
                start: &self.start,
                generation,
                temporary: self.identity,
                office,
            },
        );
        need(!runtime.cancellation().is_cancelled(), "binding_changed")?;
        allowed(self.selection.source_configuration(), &self.selection)?;
        Ok(ObservedImageBinding {
            selection: self.selection,
            digest,
            temporary: self.temporary,
            phase: self.phase,
        })
    }
}
