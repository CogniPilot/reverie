use super::*;
use reverie_core::posix_path::PosixPath;
use std::path::PathBuf;
/// A retained actual phone and its installation-selected endpoint. Binding-only
/// observations preserve source ordering; stricter reader custody follows only
/// when materialization actually selects the three fixed GETs.
pub struct OfficeImageBinding {
    phone: OfficePhone,
    pub(super) path: PathBuf,
    uid: u32,
}
impl OfficeService {
    pub fn image_binding(
        &self,
        phone: &OfficePhone,
        runtime: &WorkerRuntime,
    ) -> Result<OfficeImageBinding> {
        phone
            .assert_runtime_session(runtime, &phone.session)
            .map_err(|_| OfficeImageError::Refused("office_unavailable"))?;
        let path = match &self.company.worker_socket_root {
            Some(root) => {
                let root = PosixPath::try_new(root.codepoints())
                    .map_err(|_| OfficeImageError::Refused("office_unavailable"))?;
                let selected = root
                    .join(&PosixPath::from_scalar_text(phone.session.as_str()))
                    .join(&PosixPath::from_scalar_text("office.sock"));
                crate::native::python_path(&selected.codepoints())?
            }
            None => phone.endpoint.0.clone(),
        };
        let phone = self
            .retain_phone(phone)
            .map_err(|_| OfficeImageError::Refused("office_unavailable"))?;
        let uid = if self.company.worker_socket_root.is_some() {
            runtime.worker_identity().ids().uid()
        } else {
            crate::native::uid()
        };
        let binding = OfficeImageBinding { phone, path, uid };
        binding.identity(runtime)?;
        Ok(binding)
    }
    pub fn image_reader(
        &self,
        phone: &OfficePhone,
        runtime: &WorkerRuntime,
    ) -> Result<OfficeImageReader> {
        self.image_binding(phone, runtime)?.into_reader(runtime)
    }
}
impl OfficeImageBinding {
    pub fn session(&self) -> &ProfileSessionId {
        &self.phone.session
    }
    pub fn identity(&self, runtime: &WorkerRuntime) -> Result<[u64; 2]> {
        self.phone
            .assert_runtime_session(runtime, self.session())
            .map_err(|_| OfficeImageError::Refused("office_unavailable"))?;
        let info = fs::symlink_metadata(&self.path)?;
        let actual = [info.dev(), info.ino()];
        need(
            info.file_type().is_socket()
                && info.uid() == self.uid
                && Some(actual) == self.phone.endpoint.1,
            "office_unavailable",
        )?;
        Ok(actual)
    }
    pub fn into_reader(self, runtime: &WorkerRuntime) -> Result<OfficeImageReader> {
        let reader = OfficeImageReader { binding: self };
        reader.identity(runtime)?;
        Ok(reader)
    }
}
