use super::*;
#[derive(Clone)]
pub struct SelfModelDraft(DocumentBody);
pub struct SelfModelChange {
    body: DocumentBody,
    current_consciousness: Option<MetadataText>,
    consciousness: MetadataText,
    core_changed: bool,
}
impl SelfModelDraft {
    pub fn decode_json(raw: &str) -> Result<Self> {
        let body = DocumentBody::decode_json(raw)?;
        Self::from_body(body)
    }
    pub fn from_body(body: DocumentBody) -> Result<Self> {
        required_text(fields(&body)?, "consciousness")?;
        Ok(Self(body))
    }
    pub fn prepare(
        &self,
        current: &DocumentBody,
        reason: &MetadataText,
    ) -> Result<SelfModelChange> {
        let model = fields(&self.0)?;
        let prior = fields(current)?;
        let persona = if model.contains_key(&text("persona")) {
            required_text(model, "persona")?
        } else if prior.contains_key(&text("persona")) {
            required_text(prior, "persona")?
        } else {
            MetadataText::from_scalar_text(DEFAULT_PERSONA)
        };
        if persona.as_python_text_ref().trimmed().is_empty() || persona.codepoints().len() > 16_000
        {
            return Err(DocumentCodecError::Persona);
        }
        let Some(Value(Node::Array(directives))) = model.get(&text("directives")) else {
            return Err(DocumentCodecError::Directives);
        };
        if directives.len() > 20 || directives.iter().any(invalid_directive) {
            return Err(DocumentCodecError::Directives);
        }
        if reason.as_python_text_ref().trimmed().is_empty() {
            return Err(DocumentCodecError::Reason);
        }
        let consciousness = required_text(model, "consciousness")?;
        let current_consciousness = prior.get(&text("consciousness")).and_then(|v| {
            if let Node::String(t) = &v.0 {
                Some(MetadataText::from_text(t.clone()))
            } else {
                None
            }
        });
        let core_changed = ["consciousness", "directives"].iter().any(|key| {
            match (model.get(&text(key)), prior.get(&text(key))) {
                (Some(a), Some(b)) => !a.python_eq(b),
                _ => true,
            }
        });
        let body = DocumentBody(object(vec![
            ("persona", string_text(&persona)),
            ("consciousness", string_text(&consciousness)),
            (
                "directives",
                OrderedValue::array(
                    directives
                        .iter()
                        .map(|v| OrderedValue::scalar(v.deep_clone()))
                        .collect(),
                ),
            ),
            ("reason", string_text(reason)),
        ]));
        Ok(SelfModelChange {
            body,
            current_consciousness,
            consciousness,
            core_changed,
        })
    }
}
fn invalid_directive(value: &Value) -> bool {
    let Node::String(value) = &value.0 else {
        return true;
    };
    let text = MetadataText::from_text(value.clone());
    value.0.len() > 2_000 || text.as_python_text_ref().trimmed().is_empty()
}
impl SelfModelChange {
    pub fn body(&self) -> &DocumentBody {
        &self.body
    }
    pub fn prior_consciousness(&self) -> Option<&MetadataText> {
        self.current_consciousness.as_ref()
    }
    pub fn consciousness(&self) -> &MetadataText {
        &self.consciousness
    }
    pub fn core_changed(&self) -> bool {
        self.core_changed
    }
    pub fn core_proposal(&self) -> BallotProposal {
        let fields = fields(&self.body).expect("private constructed self model");
        let consciousness = string_text(&self.consciousness);
        let Some(Value(Node::Array(directives))) = fields.get(&text("directives")) else {
            unreachable!("private directives");
        };
        BallotProposal(DocumentBody(object(vec![
            ("consciousness", consciousness),
            (
                "directives",
                OrderedValue::array(
                    directives
                        .iter()
                        .map(|v| OrderedValue::scalar(v.deep_clone()))
                        .collect(),
                ),
            ),
        ])))
    }
}
