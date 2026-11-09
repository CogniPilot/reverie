//! Real website-side disconnects, not protocol exits or provider-stop requests.
//! Every observation belongs to the same fresh synthetic tenant/service/CID.
use super::*;
use reverie_host::website_facts::ProcessSnapshot;
mod reader;
pub(super) use reader::ProviderReader;
struct ProviderBirth {
    owner: std::sync::Weak<crate::installing_broker::launch::StartedLaptop>,
    cid: String,
    pid: u32,
    start_tick: String,
    started_at: String,
    runtime_publication: Vec<u8>,
    pane: ProcessSnapshot,
    command: ProcessSnapshot,
}
impl Attempt {
    pub(in crate::installing_broker::service::tests::native_cold) fn run_reconnect(
        &mut self,
    ) -> Result<()> {
        self.bootstrap()?;
        self.create_anchor()?;
        self.start_service()?;
        let cold_frames = self.begin_cold()?;
        require(
            cold_frames.errors.is_empty() && cold_frames.exit.is_none() && !cold_frames.eof,
            "original cold viewer must be live without an error or exit",
        )?;
        let original = self.live_provider()?;
        self.checkpoint("before-cold-eof", &original, &cold_frames)?;
        self.viewer_eof()?;
        self.same_live_provider(&original)?;
        self.checkpoint("after-cold-eof", &original, &cold_frames)?;
        let reuse_frames = self.attach_original()?;
        self.same_live_provider(&original)?;
        self.checkpoint("before-reuse-eof", &original, &reuse_frames)?;
        self.viewer_eof()?;
        self.same_live_provider(&original)?;
        self.checkpoint("after-reuse-eof", &original, &reuse_frames)?;
        let final_frames = self.attach_original()?;
        self.same_live_provider(&original)?;
        self.checkpoint("after-second-attach", &original, &final_frames)?;
        self.complete_workload(final_frames)?;
        self.stop_via_service()?;
        self.assert_released()
    }
    fn viewer_eof(&mut self) -> Result<()> {
        // Closing this real accepted client is the website-disappearance case.
        // No X/I frame, terminal signal, stop, reconciliation or resend occurs.
        let client = self.client.take().ok_or("original viewer client missing")?;
        nix::unistd::close(client).map_err(|e| e.to_string())?;
        // This physically collects the ORIGINAL published JoinHandle, socket
        // and Hold conditions. A progress response is not used as an ACK.
        self.joined()?;
        require(
            self.broker()
                .reports
                .observe_worker_handlers(self.end)
                .map_err(|e| e.to_string())?
                == reverie_host::worker_reports::WorkerHandlersProgress::Settled,
            "physical join must also leave original sockets/Holds settled",
        )?;
        let lifecycle = self
            .broker()
            .installed
            .lifecycle()
            .map_err(|e| e.to_string())?;
        require(
            lifecycle.guard.transients_empty(),
            "original viewer active/pending registrations must settle",
        )
    }
    fn attach_original(&mut self) -> Result<Frames> {
        require(self.client.is_none(), "previous viewer must close first")?;
        // Reuse the exact existing held workload by call. attachOnly prevents
        // its execution as a new command or creation if the provider is absent.
        let mut request: serde_json::Value =
            serde_json::from_slice(&self.held_request()).map_err(|e| e.to_string())?;
        request["attachOnly"] = true.into();
        let raw = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
        self.client = Some(exchange::connect(
            &self.tenant.root.join("broker/service.sock"),
            b'J',
            &raw,
        )?);
        let mut frames = Frames::default();
        self.until(&mut frames, true)?;
        require(
            frames.errors.is_empty() && frames.exit.is_none() && !frames.eof,
            "same live pane must attach without an error/exit or replay",
        )?;
        Ok(frames)
    }
    fn live_provider(&mut self) -> Result<ProviderBirth> {
        let cid = self
            .worker
            .as_ref()
            .ok_or("original Created CID missing")?
            .clone();
        let owner = {
            let life = self
                .broker()
                .installed
                .lifecycle()
                .map_err(|e| e.to_string())?;
            let entry = life
                .guard
                .iter()
                .find(|entry| entry.session == self.tenant.sid)
                .ok_or("original same-SID registration missing")?;
            let crate::installing_broker::LaptopOwner::Started(owner) = &entry.owner else {
                return Err("original Started owner changed".into());
            };
            require(
                owner
                    .created
                    .container_id()
                    .is_some_and(|id| id.as_str() == cid),
                "registration must retain original actual Created CID",
            )?;
            Arc::downgrade(owner)
        };
        let row = self.inspect(&cid)?;
        outside_production_pool(&row)?;
        require(
            row["Id"] == cid
                && row["Image"] == self.inputs.image.as_str()
                && row["Name"] == format!("/{}", self.tenant.name())
                && row["Config"]["Labels"]["reverie.worker"] == self.tenant.deployment
                && row["Config"]["Labels"]["reverie.session"] == self.tenant.sid.as_str()
                && row["State"]["Running"] == true
                && row["State"]["Restarting"] == false
                && row["State"]["Paused"] == false
                && row["State"]["Dead"] == false,
            "same original provider must remain physically running",
        )?;
        let pid = row["State"]["Pid"]
            .as_u64()
            .filter(|pid| *pid > 0)
            .and_then(|pid| u32::try_from(pid).ok())
            .ok_or("actual provider init PID")?;
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).map_err(|e| e.to_string())?;
        let start_tick = reverie_contracts::kernel_accounting::process_start(&stat)
            .map_err(|e| e.to_string())?;
        let started_at = row["State"]["StartedAt"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or("actual provider StartedAt")?
            .to_owned();
        require(
            missing(&self.exit_receipt_path()?)?
                && missing(&self.tenant.root.join("work/release"))?,
            "original controlled command must not have completed or been released",
        )?;
        self.require_storage_held()?;
        self.r_available()?;
        let engine = self.broker().storage.runtime.readonly();
        let cancellation = self.broker().storage.runtime.cancellation();
        let reader = self
            .provider_reader
            .get_or_insert_with(|| ProviderReader::new(engine));
        let id = reverie_core::ids::ContainerId::parse(&cid).map_err(|e| e.to_string())?;
        let (init, pane, command) = reader.observe(&id, self.end, &cancellation)?;
        require(
            init.pid().to_u64() == Some(u64::from(pid)) && init.start().as_str() == start_tick,
            "native process observation must bracket the same actual init",
        )?;
        self.require_native_command_mode(&pane, &command)?;
        let runtime_publication = fs::read(
            self.tenant
                .root
                .join("state")
                .join(self.tenant.sid.as_str())
                .join("runtime.json"),
        )
        .map_err(|e| e.to_string())?;
        Ok(ProviderBirth {
            owner,
            cid,
            pid,
            start_tick,
            started_at,
            runtime_publication,
            pane,
            command,
        })
    }
    fn same_live_provider(&mut self, original: &ProviderBirth) -> Result<()> {
        require(
            &self.live_provider()? == original,
            "viewer EOF/reattach must preserve original owner, provider, controller, command and publication",
        )
    }
    fn checkpoint(&self, stage: &str, birth: &ProviderBirth, frames: &Frames) -> Result<()> {
        self.storage_diagnostic(&format!("{stage}-storage.json"))?;
        tenant::write(
            &self.tenant.root.join(format!("{stage}.json")),
            &serde_json::to_vec(&serde_json::json!({"stage":stage,
                "sessionId":self.tenant.sid.as_str(),"containerId":birth.cid,
                "initPID":birth.pid,"initStartTick":birth.start_tick,"startedAt":birth.started_at,
                "runtimePublicationBytes":birth.runtime_publication,
                "paneProcess":process_data(&birth.pane),"commandProcess":process_data(&birth.command),
                "viewerOutputBytes":frames.output,"errorsBytes":frames.errors,
                "exitBytes":frames.exit,"lastReadEOF":frames.eof
            }))
            .map_err(|e| e.to_string())?,
        )
    }
    pub(super) fn close_provider_reader(&mut self) -> Result<()> {
        if let Some(reader) = &mut self.provider_reader {
            reader.close(self.end)?;
        }
        self.provider_reader = None;
        Ok(())
    }
    fn storage_diagnostic(&self, leaf: &str) -> Result<()> {
        let Some(broker) = &self.broker else {
            return Ok(());
        };
        let raw = fs::read(self.tenant.root.join("company.json")).map_err(|e| e.to_string())?;
        let company = reverie_contracts::storage_identity::decode_metadata(&raw)
            .map_err(|e| e.to_string())?;
        let rows = broker
            .storage
            .storage_status(&company)
            .map_err(|e| e.to_string())?;
        tenant::write(
            &self.tenant.root.join(leaf),
            &serde_json::to_vec(&rows).map_err(|e| e.to_string())?,
        )
    }
    pub(in crate::installing_broker::service::tests::native_cold) fn preserve_reconnect_diagnostics(
        &self,
    ) -> Result<()> {
        self.storage_diagnostic("reconnect-failure-storage.json")
    }
}

fn process_data(process: &ProcessSnapshot) -> serde_json::Value {
    serde_json::json!({"pid":process.pid().as_str(),"startTick":process.start().as_str(),
        "parent":process.parent().as_str(),"argvDigest":process.argv_digest().as_str(),
        "executable":process.executable(),"namespaces":process.namespaces()})
}

impl PartialEq for ProviderBirth {
    fn eq(&self, other: &Self) -> bool {
        // The Weak preserves the actual allocation identity against ABA but
        // cannot hold a resource alive or obstruct its normal strong-owner move.
        std::sync::Weak::ptr_eq(&self.owner, &other.owner)
            && self.cid == other.cid
            && self.pid == other.pid
            && self.start_tick == other.start_tick
            && self.started_at == other.started_at
            && self.runtime_publication == other.runtime_publication
            && self.pane == other.pane
            && self.command == other.command
    }
}

impl Attempt {
    fn require_native_command_mode(
        &self,
        pane: &ProcessSnapshot,
        command: &ProcessSnapshot,
    ) -> Result<()> {
        use reverie_core::worker_child::{CHILD_PROGRAM, LAUNCH_DIRECTORY};
        let path = self.exit_receipt_path()?;
        let exit = path
            .file_name()
            .and_then(|leaf| leaf.to_str())
            .ok_or("original paired exit leaf")?;
        let nonce = exit
            .strip_suffix(".exit")
            .ok_or("original native pane-exit publication")?;
        let exit = format!("{LAUNCH_DIRECTORY}/{exit}");
        let record = format!("{LAUNCH_DIRECTORY}/{nonce}.json");
        let wanted_pane = argv_digest(&[CHILD_PROGRAM, "--pane-exit", &exit, &record])?;
        let request: serde_json::Value =
            serde_json::from_slice(&self.held_request()).map_err(|e| e.to_string())?;
        let held = request["command"].as_str().ok_or("original held command")?;
        // execute_pane starts exactly one bare-record child. execute_record
        // replaces that same PID with [bash, -c, ORIGINAL_COMMAND]; its sleep
        // subprocesses are grandchildren of the pane wrapper, never this child.
        let wanted_command = argv_digest(&["bash", "-c", held])?;
        require(
            pane.argv_digest() == &wanted_pane
                && command.argv_digest() == &wanted_command
                && command.parent() == pane.pid(),
            "actual pane-exit wrapper and its original managed command must match",
        )
    }
}
fn argv_digest(arguments: &[&str]) -> Result<reverie_core::operations::JournalDigest> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for argument in arguments {
        hash.update(argument.as_bytes());
        hash.update([0]);
    }
    reverie_core::operations::JournalDigest::parse(&format!("{:x}", hash.finalize()))
        .map_err(|e| e.to_string())
}
