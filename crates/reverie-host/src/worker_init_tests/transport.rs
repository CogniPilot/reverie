//! Closed test transport: zero CLI exit means a reply was delivered, never
//! semantic success. The owning Host test rejects every refused/unknown reply.
use super::*;
use serde::{Deserialize, Serialize};
use std::{
    cell::{Cell, RefCell},
    io::Write,
    path::Path,
};

const PURPOSE: &str = "reverie-init-fixture-probe-v1";
const MARKER: &str = "INIT_PROBE_REPLY ";
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Phase {
    Parent,
    Child,
    Observer,
}
impl Phase {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Parent => "parent",
            Self::Child => "child",
            Self::Observer => "observer",
        }
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Outcome {
    Spawned { child: u32 },
    Reaped { child: u32 },
    Refused { diagnostic: String },
    Unconfirmed { diagnostic: String },
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    version: u8,
    purpose: String,
    phase: Phase,
    correlation: String,
    nonce: String,
    outcome: Outcome,
}
pub(super) struct Scope {
    phase: Phase,
    correlation: String,
    nonce: String,
    unconfirmed: Cell<bool>,
    native_cause: RefCell<Option<String>>,
}
impl Scope {
    /// These transport checks occur OUTSIDE catch_unwind. Accidental host
    /// --ignored execution cannot be converted into a successful helper exit.
    pub(super) fn capture(phase: Phase) -> Self {
        assert_eq!(std::env::var("REVERIE_INIT_PROBE").as_deref(), Ok("1"));
        assert_eq!(std::env::current_exe().unwrap(), Path::new(PROBE));
        assert!(std::process::id() > 1);
        assert_eq!(
            std::env::var("REVERIE_INIT_PHASE").as_deref(),
            Ok(phase.name())
        );
        let correlation = std::env::var("REVERIE_INIT_CORRELATION").unwrap();
        let suffix = correlation.strip_prefix("initfixture").unwrap();
        assert!(suffix.len() == 16 && hex(suffix));
        let nonce = std::env::var("REVERIE_INIT_NONCE").unwrap();
        assert!(nonce.len() == 32 && hex(&nonce));
        let owner = Self {
            phase,
            correlation,
            nonce,
            unconfirmed: Cell::new(false),
            native_cause: RefCell::new(None),
        };
        let hostname = owner.read("/proc/sys/kernel/hostname", 4096).unwrap();
        assert_eq!(hostname.trim(), owner.correlation);
        owner
    }
    pub(super) fn checked<T>(
        &self,
        result: Result<T, crate::ObservationError>,
    ) -> Result<T, crate::ObservationError> {
        if let Err(error) = &result
            && error.has_unconfirmed_close()
        {
            self.unconfirmed.set(true);
            self.native_cause
                .borrow_mut()
                .get_or_insert_with(|| format!("{error:?}"));
        }
        result
    }
    pub(super) fn read(
        &self,
        path: &str,
        maximum: usize,
    ) -> Result<String, crate::ObservationError> {
        let bytes = self.checked(crate::native::read_reservation(Path::new(path), maximum))?;
        String::from_utf8(bytes)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error).into())
    }
    pub(super) fn retain_native(&self, cause: &str) {
        self.unconfirmed.set(true);
        self.native_cause
            .borrow_mut()
            .get_or_insert_with(|| cause.to_owned());
    }
    fn refusal(&self, payload: &(dyn std::any::Any + Send)) -> Outcome {
        // Diagnostic text is never parsed to choose known/unknown. Only the
        // original structured native error above can latch close uncertainty.
        let primary = payload
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| payload.downcast_ref::<&str>().copied())
            .unwrap_or("non-string semantic panic");
        let diagnostic = format!("{primary}; native={:?}", self.native_cause.borrow())
            .chars()
            .take(4096)
            .collect();
        if self.unconfirmed.get() {
            Outcome::Unconfirmed { diagnostic }
        } else {
            Outcome::Refused { diagnostic }
        }
    }
    fn emit(&self, outcome: Outcome) {
        assert!(!matches!(self.phase, Phase::Child));
        let reply = Reply {
            version: 1,
            purpose: PURPOSE.into(),
            phase: self.phase,
            correlation: self.correlation.clone(),
            nonce: self.nonce.clone(),
            outcome,
        };
        println!("{MARKER}{}", serde_json::to_string(&reply).unwrap());
        std::io::stdout().flush().unwrap();
    }
}
pub(super) fn parent() {
    let scope = Scope::capture(Phase::Parent);
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| probe::parent(&scope))) {
        Ok(child) => {
            if scope.unconfirmed.get() {
                scope.emit(Outcome::Unconfirmed {
                    diagnostic: "native ownership retained".into(),
                });
            } else {
                scope.emit(Outcome::Spawned { child: child.id() });
            }
            // Deliberate contained orphan transfer only after the actual scope
            // and reply flush. The original CID owner remains outside.
            std::process::exit(0);
        }
        Err(error) => scope.emit(scope.refusal(error.as_ref())),
    }
}
pub(super) fn observer() {
    let scope = Scope::capture(Phase::Observer);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| probe::observer(&scope)));
    let outcome = match result {
        Ok(child) if !scope.unconfirmed.get() => Outcome::Reaped { child },
        Ok(_) => Outcome::Unconfirmed {
            diagnostic: "native close uncertainty retained".into(),
        },
        Err(error) => scope.refusal(error.as_ref()),
    };
    scope.emit(outcome);
}
pub(super) fn decode(
    raw: &str,
    phase: Phase,
    correlation: &str,
    nonce: &str,
) -> Result<Outcome, String> {
    let replies = raw
        .lines()
        .filter_map(|line| line.split_once(MARKER).map(|(_, rest)| rest))
        .collect::<Vec<_>>();
    if replies.len() != 1 || replies[0].len() > 16_384 {
        return Err("missing/ambiguous probe reply".into());
    }
    let reply: Reply = serde_json::from_str(replies[0]).map_err(|e| e.to_string())?;
    if reply.version != 1
        || reply.purpose != PURPOSE
        || reply.phase != phase
        || reply.correlation != correlation
        || reply.nonce != nonce
    {
        return Err("original probe phase/correlation changed".into());
    }
    Ok(reply.outcome)
}
fn hex(raw: &str) -> bool {
    raw.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn reply() -> Reply {
        Reply {
            version: 1,
            purpose: PURPOSE.into(),
            phase: Phase::Observer,
            correlation: "initfixture0123456789abcdef".into(),
            nonce: "0123456789abcdef0123456789abcdef".into(),
            outcome: Outcome::Refused {
                diagnostic: "known semantic failure".into(),
            },
        }
    }
    #[test]
    fn delivered_refusal_stays_refusal_and_is_bound_to_original_phase() {
        let original = reply();
        let raw = format!("{MARKER}{}", serde_json::to_string(&original).unwrap());
        assert!(matches!(
            decode(
                &raw,
                Phase::Observer,
                &original.correlation,
                &original.nonce
            ),
            Ok(Outcome::Refused { .. })
        ));
        assert!(decode(&raw, Phase::Parent, &original.correlation, &original.nonce).is_err());
        assert!(
            decode(
                &raw,
                Phase::Observer,
                "initfixturefedcba9876543210",
                &original.nonce
            )
            .is_err()
        );
        assert!(
            decode(
                &raw,
                Phase::Observer,
                &original.correlation,
                "fedcba9876543210fedcba9876543210"
            )
            .is_err()
        );
    }
    #[test]
    fn missing_ambiguous_or_extended_replies_never_become_known_success() {
        let original = reply();
        let raw = format!("{MARKER}{}", serde_json::to_string(&original).unwrap());
        for invalid in [
            String::new(),
            format!("{raw}\n{raw}"),
            format!("{MARKER}{{"),
        ] {
            assert!(
                decode(
                    &invalid,
                    Phase::Observer,
                    &original.correlation,
                    &original.nonce
                )
                .is_err()
            );
        }
        let mut extended = serde_json::to_value(&original).unwrap();
        extended["outcome"]["unexpected"] = true.into();
        assert!(
            decode(
                &format!("{MARKER}{extended}"),
                Phase::Observer,
                &original.correlation,
                &original.nonce
            )
            .is_err()
        );
    }
}
