use super::{
    Result, dreaming, gpu, maintenance_lock, model, now, rate, reflection, state, try_lock,
};
use reverie_host::memory_configuration::MemoryConfiguration;
use reverie_store::memory::{Memory, MemoryStore};

pub(crate) fn dream_once(
    config: &MemoryConfiguration,
    store: &MemoryStore,
) -> Result<Option<Memory>> {
    let _lock =
        try_lock(&maintenance_lock(config)?)?.ok_or("memory maintenance is already running")?;
    dreaming::run(config, store, &store.documents(None), now()?, false)
}

pub(crate) fn reflect_once(
    config: &MemoryConfiguration,
    store: &MemoryStore,
) -> Result<Vec<Memory>> {
    let _lock =
        try_lock(&maintenance_lock(config)?)?.ok_or("memory maintenance is already running")?;
    let guard = gpu::Gpu::acquire(config, "chat")?.ok_or("GPU busy")?;
    let batch = reflection::Batch::pending(store, state(store, "last_reflection_at", 0.0)?)?;
    let result = batch.run(config, store, now()?);
    guard.finish()?;
    result
}

pub(crate) fn rate_once(config: &MemoryConfiguration, store: &MemoryStore) -> Result<usize> {
    let _lock =
        try_lock(&maintenance_lock(config)?)?.ok_or("memory maintenance is already running")?;
    rate(config, store, 50)?.ok_or_else(|| "GPU busy".into())
}

pub(crate) fn router_check(config: &MemoryConfiguration) -> Option<String> {
    model::complete(config, "", "Say hi in three words.", 12, 0.0, 120, false)
}
