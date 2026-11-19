use super::{Install, Result, permissions};
use crate::opencode_context::guidance::{SAFEGUARDS, charter};
use http::Uri;
use reverie_contracts::{
    memory_instance::{MemoryInstance, identity_context, primary_agent},
    storage_identity::MetadataText,
};
use reverie_core::memory_documents::assignment_byte_budget;
use serde_json::{Value, json};

const CHAT_TOOLS: [&str; 4] = [
    "interaction_mode",
    "reverie_memory",
    "reverie_room",
    "agent_profile",
];

pub(super) fn role(instance: Option<&MemoryInstance>) -> Result<String> {
    instance.map_or_else(|| Ok("Expert".into()), |instance| scalar(instance.role()))
}

fn scalar(value: &MetadataText) -> Result<String> {
    value
        .as_python_text_ref()
        .scalar_text()
        .map(std::borrow::Cow::into_owned)
        .ok_or_else(|| "instance identity requires Unicode text".into())
}

pub(super) fn configuration(args: &Install, instance: Option<&MemoryInstance>) -> Result<Value> {
    let permitted = permissions(false);
    let prompt = format!(
        "{}\n{}\n{SAFEGUARDS}",
        scalar(&identity_context(instance))?,
        charter(&role(instance)?)
    );
    let mut conversation = json!({"*":"deny", "reverie_return":permitted["reverie_return"]});
    for tool in CHAT_TOOLS {
        conversation[tool] = json!("allow");
    }
    let agent = primary_agent(instance);
    let mut config = json!({
        "$schema": "https://opencode.ai/config.json", "default_agent": agent,
        "model": args.model, "small_model": args.model, "permission": permitted,
        "agent": {
            (agent): {
                "description": "Conversation and owner-authorized reverie maintenance",
                "mode":"primary", "prompt":prompt, "steps":10, "permission":conversation,
            },
            "coding": {
                "description":"Bounded coding, then return to chat", "mode":"primary", "prompt":prompt,
                "steps":24, "permission":permitted,
            },
        },
    });
    if let Some(base) = args.api_base.as_deref().filter(|base| !base.is_empty()) {
        config["provider"] = provider(base, args)?;
    }
    Ok(config)
}

fn provider(base: &str, args: &Install) -> Result<Value> {
    let endpoint = base.parse::<Uri>().ok().filter(|uri| {
        matches!(uri.scheme_str(), Some("http" | "https"))
            && uri
                .authority()
                .is_some_and(|authority| !authority.as_str().contains('@'))
            && !base.contains(['#', '?'])
    });
    if endpoint.is_none() {
        return Err("model API URL must not contain credentials, query or fragment".into());
    }
    let (provider, model) = args
        .model
        .split_once('/')
        .filter(|(provider, model)| !provider.is_empty() && !model.is_empty())
        .ok_or("use provider/model for the local runtime")?;
    if assignment_byte_budget(args.context_window, args.output_tokens, 0)? < 512 {
        return Err("model limits leave insufficient room for a task".into());
    }
    let key = api_key(args.api_key_env.as_deref())?;
    Ok(json!({
        (provider): {
            "npm": "@ai-sdk/openai-compatible", "name": "Reverie local GPU",
            "options": {"baseURL": base.trim_end_matches('/'), "apiKey": key, "timeout":300000},
            "models": {(model): {
                "name":model, "tool_call":true, "limit":{"context":args.context_window,"output":args.output_tokens},
            }},
        },
    }))
}

fn api_key(name: Option<&str>) -> Result<String> {
    let Some(name) = name.filter(|name| !name.is_empty()) else {
        return Ok("local".into());
    };
    let mut iter = name.bytes();
    let valid = iter
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && iter.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
    if !valid {
        return Err("API key must name an environment variable".into());
    }
    Ok(format!("{{env:{name}}}"))
}
