use super::Result;
use reverie_application::memory_startup::install_owner_identity;
use reverie_contracts::{
    memory_documents::{BallotProposal, BriefRequest, DocumentBody, SelfModelDraft},
    storage_identity::MetadataText,
};
use reverie_core::{
    memory::trim_text,
    memory_documents::{BallotCategory, DeveloperName, DocumentName, DocumentRevision},
};
use reverie_store::memory::{BallotOutcome, DocumentEnvelope, MemoryDocuments, MemoryStore};
use serde::Deserialize;
use serde_json::{Map, Value, json};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(super) enum Request {
    Return,
    Votes,
    SelfHistory,
    Plan {
        #[serde(default, deserialize_with = "present")]
        text: Option<String>,
        revision: Option<i64>,
    },
    Profiles,
    Profile {
        name: String,
        profile: Value,
        revision: i64,
    },
    Brief {
        #[serde(flatten)]
        fields: Map<String, Value>,
    },
    #[serde(rename = "self")]
    SelfModel {
        #[serde(default, deserialize_with = "present")]
        model: Option<Value>,
        reason: Option<String>,
        revision: Option<i64>,
    },
    SelfVote {
        model: Core,
        reason: String,
    },
    PublicationProposal {
        proposal: String,
        reason: String,
    },
}

fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Deserialize, serde::Serialize)]
pub(super) struct Core {
    consciousness: String,
    directives: Vec<String>,
}

impl Request {
    pub(super) fn apply(self, docs: &MemoryDocuments<'_>) -> Result<Value> {
        match self {
            Self::Return => resume(docs),
            Self::Votes => votes(docs),
            Self::SelfHistory => self_history(docs),
            Self::Plan { text, revision } => plan(docs, text, revision),
            Self::Profiles => profiles(docs),
            Self::Profile {
                name,
                profile,
                revision,
            } => envelope(docs.save_profile(
                &DeveloperName::parse(&name)?,
                &decode(&profile)?,
                DocumentRevision::try_new(revision)?,
            )?),
            Self::Brief { fields } => {
                let request = BriefRequest::decode_json(&Value::Object(fields).to_string())?;
                Ok(json!(docs.brief(&request)?))
            }
            Self::SelfModel {
                model,
                reason,
                revision,
            } => save_self(docs, model, reason, revision),
            Self::SelfVote { model, reason } => self_vote(docs, model, &reason),
            Self::PublicationProposal { proposal, reason } => publication(docs, &proposal, &reason),
        }
    }
}

pub(super) fn initialized(
    store: &MemoryStore,
    initial: DocumentBody,
) -> Result<MemoryDocuments<'_>> {
    let docs = store.documents(Some(initial.clone()));
    docs.initialize()?;
    if docs.self_model()?.revision.value() == 0 {
        store.atomic_immediate(|tx| {
            if tx.beliefs()?.is_empty() {
                install_owner_identity(tx, &docs, initial)?;
            }
            Ok(())
        })?;
    }
    Ok(docs)
}

fn name(value: &str) -> DocumentName {
    DocumentName::from_scalar_text(value)
}

fn decode(value: &Value) -> Result<DocumentBody> {
    Ok(DocumentBody::decode_json(&value.to_string())?)
}

fn body(value: DocumentEnvelope) -> Result<Value> {
    Ok(serde_json::from_slice(&value.body.as_json())?)
}

fn envelope(value: DocumentEnvelope) -> Result<Value> {
    let revision = value.revision.value();
    let updated = value.updated_at;
    let mut reply = json!({ "revision": revision, "body": body(value)? });
    if let Some(at) = updated {
        reply["updated_at"] = json!(at);
    }
    Ok(reply)
}

fn revision(value: Option<i64>) -> Result<DocumentRevision> {
    Ok(DocumentRevision::try_new(
        value.ok_or("revision is required")?,
    )?)
}

fn plan(docs: &MemoryDocuments<'_>, text: Option<String>, version: Option<i64>) -> Result<Value> {
    let Some(text) = text else {
        return envelope(docs.plan()?);
    };
    if trim_text(&text).is_empty() {
        return Err("plan must be nonempty text".into());
    }
    let plan = DocumentBody::plan(&MetadataText::from_scalar_text(&text));
    envelope(docs.write(&name("plan"), &plan, revision(version)?)?)
}

fn profiles(docs: &MemoryDocuments<'_>) -> Result<Value> {
    let values = docs
        .profiles()?
        .into_iter()
        .map(|(key, value)| Ok((key, envelope(value)?)))
        .collect::<Result<Map<_, _>>>()?;
    Ok(Value::Object(values))
}

fn save_self(
    docs: &MemoryDocuments<'_>,
    model: Option<Value>,
    reason: Option<String>,
    version: Option<i64>,
) -> Result<Value> {
    let Some(model) = model else {
        return envelope(docs.self_model()?);
    };
    let draft = SelfModelDraft::decode_json(&model.to_string())?;
    let reason = MetadataText::from_scalar_text(&reason.ok_or("self revision requires a reason")?);
    envelope(docs.save_self(&draft, &reason, revision(version)?)?)
}

fn resume(docs: &MemoryDocuments<'_>) -> Result<Value> {
    let name = name("lifecycle");
    let current = docs.read(&name, None)?;
    let active = decode(&json!({
        "mode": "active",
        "needs_handoff": true,
        "next_action": "Read current reverie state and obtain owners' handoffs before taking work",
    }))?;
    envelope(docs.write(&name, &active, current.revision)?)
}

fn self_history(docs: &MemoryDocuments<'_>) -> Result<Value> {
    let history: Vec<_> = docs
        .history(&name("self"))?
        .into_iter()
        .map(|row| {
            json!({"name": row.name, "revision": row.revision.value(),
               "body": row.body, "archived_at": row.archived_at})
        })
        .collect();
    Ok(json!(history))
}

fn votes(docs: &MemoryDocuments<'_>) -> Result<Value> {
    let history: Vec<_> = docs
        .ballot_history()?
        .into_iter()
        .map(|row| {
            json!({"category": row.category, "week": row.week, "proposal_hash": row.proposal_hash,
               "proposal": row.proposal, "reason": row.reason, "at": row.at})
        })
        .collect();
    Ok(json!(history))
}

fn outcome(value: &BallotOutcome) -> Value {
    json!({"category": value.category, "proposal_hash": value.proposal_hash,
           "consecutive_weeks": value.consecutive_weeks, "approved": value.approved,
           "next_week_at": value.next_week_at})
}

fn self_vote(docs: &MemoryDocuments<'_>, model: Core, reason: &str) -> Result<Value> {
    if model
        .directives
        .iter()
        .any(|line| trim_text(line).is_empty() || line.chars().count() > 2000)
    {
        return Err("core proposal needs consciousness and a list of directive statements".into());
    }
    let fields = serde_json::to_value(model)?;
    let proposal = BallotProposal::decode_json(&fields.to_string())?;
    let reason = MetadataText::from_scalar_text(reason);
    let vote = docs.vote(&BallotCategory::parse("core")?, &proposal, &reason)?;
    let current = docs.self_model()?;
    let version = current.revision;
    let contents = serde_json::from_slice::<Value>(&current.body.as_json())?;
    let current = if vote.outcome().approved
        && fields.as_object().is_some_and(|fields| {
            fields
                .iter()
                .any(|(key, value)| contents.get(key) != Some(value))
        }) {
        let draft = SelfModelDraft::decode_json(&fields.to_string())?;
        docs.save_self_with_vote(&draft, &reason, version, &vote)?
    } else {
        current
    };
    Ok(json!({"ballot": outcome(vote.outcome()), "self": envelope(current)?}))
}

fn publication(docs: &MemoryDocuments<'_>, proposal: &str, reason: &str) -> Result<Value> {
    if trim_text(proposal).is_empty() {
        return Err("describe the exact publication scope, excluded private history and review requirements".into());
    }
    let proposed = json!({ "scope": proposal, "automatic_upload": false });
    let ballot = docs.vote(
        &BallotCategory::parse("publication")?,
        &BallotProposal::decode_json(&proposed.to_string())?,
        &MetadataText::from_scalar_text(reason),
    )?;
    let vote = outcome(ballot.outcome());
    let next = if ballot.outcome().approved {
        let key = name("publication_request");
        let record = decode(
            &json!({"proposal": proposal, "status": "owner_review_required",
                                    "automatic_upload": false, "votes": vote}),
        )?;
        let current = docs.read(&key, None)?;
        docs.write(&key, &record, current.revision)?;
        "Ask the owner to review the concrete publication package"
    } else {
        "Reconsider explicitly in the next UTC calendar week; no upload is authorized"
    };
    Ok(json!({"ballot": vote, "next_action": next}))
}
