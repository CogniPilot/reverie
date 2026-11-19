use crate::{Target, configuration::hex};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use http::{StatusCode, uri::PathAndQuery};
use serde::Serialize;
use sha2::{Digest as _, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs::OpenOptions,
    io::{self, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, watch},
    time::Instant,
};

#[cfg(test)]
mod tests;

pub(crate) const COOKIE: &str = "__Host-reverie_preview";
pub(crate) const OPEN_PATH: &str = "/__reverie_preview_open";
const ACCESS_TTL: Duration = Duration::from_secs(1_800);
const LINK_TTL: Duration = Duration::from_secs(60);
const MAX_GRANTS: usize = 32;
const MAX_LINKS: usize = 8;
const MAX_COOKIES: usize = 8;
const MAX_RATE: usize = 600;

type Secret = [u8; 32];
type Result<T> = std::result::Result<T, StatusCode>;

pub(crate) struct Registry {
    grants: Mutex<Vec<Grant>>,
    domain: String,
    port: u16,
    audit_file: std::path::PathBuf,
    active: Arc<Semaphore>,
}

struct Grant {
    identity: Arc<Identity>,
    authority: String,
    links: HashMap<Secret, Link>,
    cookies: Vec<Secret>,
    requests: VecDeque<Instant>,
    revocation: watch::Sender<()>,
    slots: Arc<Semaphore>,
}

pub(crate) struct Identity {
    pub(crate) id: String,
    pub(crate) session: String,
    pub(crate) port: u16,
    pub(crate) target: Target,
    pub(crate) expires: Instant,
}

struct Link {
    expires: Instant,
    page: PathAndQuery,
}

pub(crate) struct Access {
    pub(crate) identity: Arc<Identity>,
    pub(crate) revocation: watch::Receiver<()>,
    _global: OwnedSemaphorePermit,
    _local: OwnedSemaphorePermit,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    id: String,
    session_id: String,
    port: u16,
    origin: String,
    expires_in: u64,
}

#[derive(Serialize)]
pub(crate) struct Created {
    preview: Summary,
    url: String,
}

pub(crate) struct Opened {
    pub(crate) page: PathAndQuery,
    pub(crate) cookie: String,
    pub(crate) max_age: u64,
}

impl Registry {
    pub(crate) fn new(config: &crate::Config, actual_port: u16) -> Self {
        Self {
            grants: Mutex::new(Vec::new()),
            domain: config.domain.clone(),
            port: actual_port,
            audit_file: config.audit_file.clone(),
            active: Arc::new(Semaphore::new(16)),
        }
    }

    pub(crate) fn list(&self) -> Vec<Summary> {
        let mut grants = self.grants.lock().expect("preview registry mutex");
        prune(&mut grants);
        grants.iter().map(Grant::summary).collect()
    }

    pub(crate) fn expose(
        &self,
        session: String,
        port: u16,
        target: Target,
        page: PathAndQuery,
    ) -> Result<Created> {
        let mut grants = self.grants.lock().expect("preview registry mutex");
        prune(&mut grants);
        if grants.len() >= MAX_GRANTS {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let id = format!("{:032x}", u128::from_be_bytes(random()?));
        if grants.iter().any(|grant| grant.identity.id == id) {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        let authority = format!("{id}.{}:{}", self.domain, self.port);
        let identity = Arc::new(Identity {
            id,
            session,
            port,
            target,
            expires: Instant::now() + ACCESS_TTL,
        });
        let mut grant = Grant {
            identity,
            authority,
            links: HashMap::new(),
            cookies: Vec::new(),
            requests: VecDeque::new(),
            revocation: watch::channel(()).0,
            slots: Arc::new(Semaphore::new(4)),
        };
        let url = grant.open_link(page)?;
        audit(&self.audit_file, "preview_expose", &grant.identity)?;
        let preview = grant.summary();
        grants.push(grant);
        Ok(Created { preview, url })
    }

    pub(crate) fn link(&self, id: &str, page: PathAndQuery) -> Result<String> {
        let mut grants = self.grants.lock().expect("preview registry mutex");
        prune(&mut grants);
        let index = find(&grants, id)?;
        grants[index].open_link(page)
    }

    pub(crate) fn revoke(&self, id: &str) -> Result<()> {
        let mut grants = self.grants.lock().expect("preview registry mutex");
        prune(&mut grants);
        let index = find(&grants, id)?;
        audit(
            &self.audit_file,
            "preview_unexpose",
            &grants[index].identity,
        )?;
        grants.remove(index);
        Ok(())
    }

    pub(crate) fn invalidate(&self, identity: &Arc<Identity>) {
        self.grants
            .lock()
            .expect("preview registry mutex")
            .retain(|grant| !Arc::ptr_eq(&grant.identity, identity));
    }

    pub(crate) fn exists(&self, authority: &str) -> bool {
        let mut grants = self.grants.lock().expect("preview registry mutex");
        prune(&mut grants);
        grants.iter().any(|grant| grant.authority == authority)
    }

    pub(crate) fn exchange(&self, authority: &str, token: &str) -> Result<Opened> {
        let mut grants = self.grants.lock().expect("preview registry mutex");
        let grant = on_origin(&mut grants, authority)?;
        let link = grant
            .links
            .remove(&digest(token))
            .ok_or(StatusCode::FORBIDDEN)?;
        if grant.cookies.len() >= MAX_COOKIES {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let cookie = token_value()?;
        audit(&self.audit_file, "preview_open", &grant.identity)?;
        grant.cookies.push(digest(&cookie));
        Ok(Opened {
            page: link.page,
            cookie,
            max_age: grant.seconds_remaining(),
        })
    }

    pub(crate) fn access(
        &self,
        authority: &str,
        cookie: &str,
        path_allowed: bool,
    ) -> Result<Access> {
        let mut grants = self.grants.lock().expect("preview registry mutex");
        let grant = on_origin(&mut grants, authority)?;
        if !grant.cookies.contains(&digest(cookie)) {
            return Err(StatusCode::FORBIDDEN);
        }
        if !path_allowed {
            return Err(StatusCode::NOT_FOUND);
        }
        let now = Instant::now();
        while grant
            .requests
            .front()
            .is_some_and(|at| now.duration_since(*at) > LINK_TTL)
        {
            grant.requests.pop_front();
        }
        if grant.requests.len() >= MAX_RATE {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let global = self
            .active
            .clone()
            .try_acquire_owned()
            .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
        let local = grant
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
        grant.requests.push_back(now);
        Ok(Access {
            identity: grant.identity.clone(),
            revocation: grant.revocation.subscribe(),
            _global: global,
            _local: local,
        })
    }
}

fn prune(grants: &mut Vec<Grant>) {
    let now = Instant::now();
    grants.retain_mut(|grant| {
        grant.links.retain(|_, link| link.expires > now);
        grant.identity.expires > now
    });
}

fn find(grants: &[Grant], id: &str) -> Result<usize> {
    if !hex(id, 32) {
        return Err(StatusCode::NOT_FOUND);
    }
    grants
        .iter()
        .position(|grant| grant.identity.id == id)
        .ok_or(StatusCode::NOT_FOUND)
}

fn on_origin<'a>(grants: &'a mut Vec<Grant>, authority: &str) -> Result<&'a mut Grant> {
    prune(grants);
    grants
        .iter_mut()
        .find(|grant| grant.authority == authority)
        .ok_or(StatusCode::NOT_FOUND)
}

impl Grant {
    fn origin(&self) -> String {
        format!("https://{}", self.authority)
    }

    fn summary(&self) -> Summary {
        Summary {
            id: self.identity.id.clone(),
            session_id: self.identity.session.clone(),
            port: self.identity.port,
            origin: self.origin(),
            expires_in: self.seconds_remaining(),
        }
    }

    fn seconds_remaining(&self) -> u64 {
        self.identity
            .expires
            .saturating_duration_since(Instant::now())
            .as_secs()
    }

    fn open_link(&mut self, page: PathAndQuery) -> Result<String> {
        if self.links.len() >= MAX_LINKS {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let token = token_value()?;
        self.links.insert(
            digest(&token),
            Link {
                expires: Instant::now() + LINK_TTL,
                page,
            },
        );
        Ok(format!("{}{OPEN_PATH}?token={token}", self.origin()))
    }
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0; N];
    getrandom::getrandom(&mut bytes).map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(bytes)
}

fn token_value() -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(random::<32>()?))
}

fn digest(value: &str) -> Secret {
    Sha256::digest(value.as_bytes()).into()
}

fn audit(path: &Path, action: &str, identity: &Identity) -> Result<()> {
    append_audit(path, action, identity).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn append_audit(path: &Path, action: &str, identity: &Identity) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != nix::unistd::geteuid().as_raw() {
        return Err(super::invalid("preview audit file is not privately owned"));
    }
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    let mut row = serde_json::to_vec(&serde_json::json!({
        "ts": SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis(),
        "admin": "owner", "action": action, "target": identity.session,
        "detail": {"previewId": identity.id, "port": identity.port},
    }))?;
    row.push(b'\n');
    file.write_all(&row)
}
