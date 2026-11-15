use super::args::Home;
use super::context::{self, ContextReadback};
use super::files::Files;
use super::input::{self, Material, Payload};
use super::{Failure, Result, join, need};
use nix::unistd::geteuid;
use serde::{Deserialize, Serialize};
use std::path::Path;
const MANIFEST_LIMIT: usize = 64 * 1024;
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u8,
    purpose: String,
    material: Material,
    context: ContextReadback,
}
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityManifest {
    version: u8,
    purpose: String,
    session_id: String,
    container_id: String,
    token_digest: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Receipt {
    version: u8,
    purpose: &'static str,
    operation_id: String,
    session_id: String,
    container_id: String,
    projection_digest: String,
    read_mode: &'static str,
    installed_auth_digest: String,
    observed_auth_digest: String,
    token_digest: String,
    context_digest: String,
    observed_context_digest: String,
    home_dev: String,
    home_ino: String,
    config_dev: String,
    config_ino: String,
}
struct Generation {
    home: usize,
    id: usize,
    config: usize,
}
fn open_home(files: &mut Files, path: &Path, home: Home) -> Result<usize> {
    let id = files.root(path, geteuid().as_raw(), true)?;
    let actual = files.identity(id)?;
    need(
        actual.dev == home.dev && actual.ino == home.ino,
        "home-identity",
    )?;
    Ok(id)
}
fn parent(files: &mut Files, home: usize, operation: &str, create: bool) -> Result<usize> {
    let private = files.child(home, ".reverie", create, true)?;
    let plans = files.child(private, "plan-moves", create, true)?;
    files.child(plans, operation, create, true)
}
fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|e| Failure::new("generation-json", e))
}
fn read<T: serde::de::DeserializeOwned + Serialize>(
    files: &mut Files,
    id: usize,
    name: &str,
) -> Result<T> {
    let bytes = files.read(id, name, MANIFEST_LIMIT, true)?;
    let value: T =
        serde_json::from_slice(&bytes).map_err(|e| Failure::new("generation-json", e))?;
    need(encode(&value)? == bytes, "generation-canonical")?;
    Ok(value)
}
fn generation_name(projection: &str) -> String {
    format!("generation-{projection}")
}
fn create(
    files: &mut Files,
    home: usize,
    payload: &Payload,
    projection: &str,
    attempt: &str,
) -> Result<Generation> {
    let parent = parent(files, home, &payload.operation_id, true)?;
    let final_name = generation_name(projection);
    if !files.absent(parent, &final_name)? {
        let id = files.child(parent, &final_name, false, true)?;
        let config = files.child(id, payload.provider.directory(), false, true)?;
        return Ok(Generation { home, id, config });
    }
    let pending = format!("pending-{attempt}");
    need(
        files.absent(parent, &pending)?,
        "generation-pending-retained",
    )?;
    let id = files.new_child(parent, &pending)?;
    let config = files.child(id, payload.provider.directory(), true, true)?;
    files.write_new(
        config,
        payload.provider.credential(),
        payload.auth.as_bytes(),
    )?;
    let context = context::install(files, home, config, &payload.context)?;
    let manifest = Manifest {
        version: 1,
        purpose: "reverie-plan-generation-v1".into(),
        material: Material::from_payload(payload),
        context,
    };
    files.write_new(id, "manifest.json", &encode(&manifest)?)?;
    files.sync(config)?;
    files.sync(id)?;
    files.publish_directory(parent, &pending, &final_name, id)?;
    Ok(Generation { home, id, config })
}
fn identity_name(container: &str) -> String {
    format!("identity-{container}.json")
}
fn add_identity(files: &mut Files, generation: &Generation, payload: &Payload) -> Result<()> {
    let name = payload.identity_filename();
    if files.absent(generation.id, &name)? {
        files.write_new(generation.id, &name, payload.identity.as_bytes())?;
    } else {
        need(
            files.read(generation.id, &name, 2048, true)? == payload.identity.as_bytes(),
            "identity-existing-mismatch",
        )?;
    }
    let value = IdentityManifest {
        version: 1,
        purpose: "reverie-plan-identity-v1".into(),
        session_id: payload.session_id.clone(),
        container_id: payload.container_id.clone(),
        token_digest: input::digest(payload.identity.as_bytes()),
    };
    let metadata = identity_name(&payload.container_id);
    if files.absent(generation.id, &metadata)? {
        files.write_new(generation.id, &metadata, &encode(&value)?)?;
    } else {
        need(
            read::<IdentityManifest>(files, generation.id, &metadata)? == value,
            "identity-manifest-existing",
        )?;
    }
    Ok(())
}
fn validate_manifest(value: &Manifest, operation: &str, projection: &str) -> Result<()> {
    need(
        value.version == 1 && value.purpose == "reverie-plan-generation-v1",
        "generation-purpose",
    )?;
    value.material.validate()?;
    need(
        value.material.operation_id == operation && value.material.digest()? == projection,
        "generation-projection",
    )
}
fn identity_entry(name: &str) -> bool {
    name.strip_prefix("worker-identity-")
        .is_some_and(input::valid_digest)
        || name
            .strip_prefix("identity-")
            .and_then(|v| v.strip_suffix(".json"))
            .is_some_and(input::valid_digest)
}
fn inventory(files: &mut Files, generation: &Generation, manifest: &Manifest) -> Result<()> {
    let expected = manifest.material.provider.directory();
    need(
        files
            .names(generation.id)?
            .iter()
            .all(|name| name == "manifest.json" || name == expected || identity_entry(name)),
        "generation-unexpected-entry",
    )?;
    need(
        files.names(generation.config)?.iter().all(|name| {
            name == manifest.material.provider.credential()
                || manifest
                    .material
                    .context
                    .roles
                    .iter()
                    .any(|role| role.filename() == name)
        }),
        "account-unexpected-entry",
    )?;
    files.seal_directory(generation.id)?;
    files.seal_directory(generation.config)
}
fn auth_readback(
    files: &mut Files,
    config: usize,
    material: &Material,
    initial: bool,
) -> Result<String> {
    let auth = files.read(config, material.provider.credential(), 128 * 1024, initial)?;
    let observed = input::digest(&auth);
    let current: serde_json::Value =
        serde_json::from_slice(&auth).map_err(|e| Failure::new("current-account-json", e))?;
    need(current.is_object(), "current-account-object")?;
    need(
        !initial || observed == material.auth_digest,
        "account-initial-readback",
    )?;
    Ok(observed)
}
fn verify(
    files: &mut Files,
    generation: &Generation,
    operation: &str,
    container: &str,
    projection: &str,
    initial: bool,
) -> Result<Receipt> {
    let manifest: Manifest = read(files, generation.id, "manifest.json")?;
    validate_manifest(&manifest, operation, projection)?;
    let material = &manifest.material;
    let observed_auth_digest = auth_readback(files, generation.config, material, initial)?;
    if initial {
        inventory(files, generation, &manifest)?;
    }
    let observed_context = context::verify(
        files,
        generation.home,
        generation.config,
        &material.context,
        &manifest.context,
        initial,
    )?;
    let identity: IdentityManifest = read(files, generation.id, &identity_name(container))?;
    need(
        identity.version == 1
            && identity.purpose == "reverie-plan-identity-v1"
            && identity.session_id == material.session_id
            && identity.container_id == container
            && input::valid_digest(&identity.token_digest),
        "identity-manifest",
    )?;
    let token = files.read(
        generation.id,
        &format!("worker-identity-{container}"),
        2048,
        true,
    )?;
    need(
        input::digest(&token) == identity.token_digest,
        "identity-readback",
    )?;
    let home = files.identity(generation.home)?;
    let config = files.identity(generation.config)?;
    files.current()?;
    Ok(Receipt {
        version: 1,
        purpose: if initial {
            "reverie-plan-installed-v1"
        } else {
            "reverie-plan-live-observation-v1"
        },
        operation_id: operation.into(),
        session_id: material.session_id.clone(),
        container_id: container.into(),
        projection_digest: projection.into(),
        read_mode: if initial { "initial" } else { "live" },
        installed_auth_digest: material.auth_digest.clone(),
        observed_auth_digest,
        token_digest: identity.token_digest,
        context_digest: input::digest(&encode(&manifest.context)?),
        observed_context_digest: input::digest(&encode(&observed_context)?),
        home_dev: home.dev.to_string(),
        home_ino: home.ino.to_string(),
        config_dev: config.dev.to_string(),
        config_ino: config.ino.to_string(),
    })
}
pub(super) fn install(
    path: &Path,
    home: Home,
    payload: &Payload,
    projection: &str,
    attempt: &str,
) -> Result<Receipt> {
    need(
        input::valid_digest(projection) && input::valid_uuid(attempt),
        "install-scope",
    )?;
    need(
        Material::from_payload(payload).digest()? == projection,
        "material-projection",
    )?;
    let mut files = Files::new();
    let result = (|| {
        let home = open_home(&mut files, path, home)?;
        let generation = create(&mut files, home, payload, projection, attempt)?;
        let manifest: Manifest = read(&mut files, generation.id, "manifest.json")?;
        need(
            manifest.material == Material::from_payload(payload),
            "generation-existing-material",
        )?;
        validate_manifest(&manifest, &payload.operation_id, projection)?;
        context::verify(
            &mut files,
            home,
            generation.config,
            &payload.context,
            &manifest.context,
            true,
        )?;
        need(
            files.read(
                generation.config,
                payload.provider.credential(),
                128 * 1024,
                true,
            )? == payload.auth.as_bytes(),
            "account-existing-material",
        )?;
        add_identity(&mut files, &generation, payload)?;
        verify(
            &mut files,
            &generation,
            &payload.operation_id,
            &payload.container_id,
            projection,
            true,
        )
    })();
    let finalizer = files.close_all();
    join(result, finalizer)
}
pub(super) fn status(
    path: &Path,
    home: Home,
    operation: &str,
    container: &str,
    projection: &str,
    initial: bool,
) -> Result<Receipt> {
    need(
        input::valid_uuid(operation)
            && input::valid_digest(container)
            && input::valid_digest(projection),
        "status-scope",
    )?;
    let mut files = Files::new();
    let result = (|| {
        let home = open_home(&mut files, path, home)?;
        let parent = parent(&mut files, home, operation, false)?;
        let id = files.child(parent, &generation_name(projection), false, true)?;
        let manifest: Manifest = read(&mut files, id, "manifest.json")?;
        validate_manifest(&manifest, operation, projection)?;
        let config = files.child(id, manifest.material.provider.directory(), false, true)?;
        verify(
            &mut files,
            &Generation { home, id, config },
            operation,
            container,
            projection,
            initial,
        )
    })();
    let finalizer = files.close_all();
    join(result, finalizer)
}
#[cfg(test)]
mod tests;
