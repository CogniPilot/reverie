use crate::refused;
use nix::libc;
use reverie_core::{ids::ChatRoomId, memory::HashedEmbedder};
use reverie_host::memory_instance::LoadedMemoryInstance;
use reverie_store::memory::{MemoryReadProfile, MemoryReader, MemoryStore};
use std::{
    fs::{self, DirBuilder, OpenOptions, Permissions},
    io,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};

pub(crate) struct Database {
    rooms: PathBuf,
    room: PathBuf,
    file: PathBuf,
}

impl Database {
    pub(crate) fn for_room(instance: &Path, room: &ChatRoomId) -> io::Result<Self> {
        if !instance.is_absolute() {
            return Err(refused());
        }
        let instance = LoadedMemoryInstance::load(instance).map_err(|_| refused())?;
        let rooms = instance
            .native_data_directory()?
            .join("harness-room-memory-v1");
        let room = rooms.join(room.as_str());
        let file = room.join("memory.sqlite");
        Ok(Self { rooms, room, file })
    }

    pub(crate) fn read_only(&self) -> io::Result<Option<MemoryReader>> {
        if !existing(&self.rooms, true)? || !existing(&self.room, true)? || !self.check_files()? {
            return Ok(None);
        }
        let reader = MemoryReadProfile::open_native(&self.file)
            .map_err(|_| refused())?
            .bind(Arc::new(HashedEmbedder::default()), 0.995)
            .map_err(|_| refused())?;
        Ok(Some(reader))
    }

    pub(crate) fn writable(&self) -> io::Result<MemoryStore> {
        ensure_directory(&self.rooms, true)?;
        ensure_directory(&self.room, false)?;
        self.check_files()?;
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&self.file)?;
        if !file.metadata()?.is_file() {
            return Err(refused());
        }
        file.set_permissions(Permissions::from_mode(0o600))?;
        MemoryStore::open(&self.file).map_err(|_| refused())
    }

    fn check_files(&self) -> io::Result<bool> {
        let present = existing(&self.file, false)?;
        for sidecar in [
            "memory.sqlite-journal",
            "memory.sqlite-wal",
            "memory.sqlite-shm",
        ] {
            if existing(&self.room.join(sidecar), false)? && !present {
                return Err(refused());
            }
        }
        Ok(present)
    }
}

fn ensure_directory(path: &Path, parents: bool) -> io::Result<()> {
    if !existing(path, true)? {
        let created = DirBuilder::new()
            .mode(0o700)
            .recursive(parents)
            .create(path);
        if let Err(error) = created
            && error.kind() != io::ErrorKind::AlreadyExists
        {
            return Err(error);
        }
        if !existing(path, true)? {
            return Err(refused());
        }
    }
    Ok(())
}

fn existing(path: &Path, directory: bool) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta)
            if if directory {
                meta.is_dir()
            } else {
                meta.is_file()
            } =>
        {
            Ok(true)
        }
        Ok(_) => Err(refused()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}
