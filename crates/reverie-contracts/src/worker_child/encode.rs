use crate::legacy_json::{Node, Number, Text, Value, ordered::OrderedValue};
use crate::worker_launch::{RequestField, WorkerRequest};
/// Exact default json.dump bytes after the broker's fixed env injection. This
/// inert record DATA cannot create a file, admit a start or authorize execution.
pub fn encode_launch_record(request: &WorkerRequest) -> Vec<u8> {
    let fields = request
        .field_order()
        .iter()
        .map(|field| {
            let value = match field {
                RequestField::Session => scalar_text(request.session().as_str()),
                RequestField::Cwd => text(request.directory().codepoints()),
                RequestField::Command => text(request.command().codepoints()),
                RequestField::Environment => environment(request),
                RequestField::Columns => number(request.terminal().cols()),
                RequestField::Rows => number(request.terminal().rows()),
                RequestField::AttachOnly => OrderedValue::scalar(Value(Node::Bool(
                    request.attach_only().expect("captured attach field"),
                ))),
            };
            (key(field.name()), value)
        })
        .collect();
    OrderedValue::object(fields).encode()
}
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn text(value: &[u32]) -> OrderedValue {
    OrderedValue::scalar(Value(Node::String(Text(value.to_vec()))))
}
fn scalar_text(value: &str) -> OrderedValue {
    text(&value.chars().map(u32::from).collect::<Vec<_>>())
}
fn number(value: u16) -> OrderedValue {
    OrderedValue::scalar(Value(Node::Number(Number::Integer(value.to_string()))))
}
fn environment(request: &WorkerRequest) -> OrderedValue {
    let mut fields = request
        .environment()
        .entries()
        .iter()
        .map(|(name, value)| (key(name.as_str()), text(value)))
        .collect::<Vec<_>>();
    let mut path="/home/agent/.nix-profile/bin:/home/agent/.local/bin:/home/agent/.local/state/nix/profiles/profile/bin:/bin:".chars().map(u32::from).collect::<Vec<_>>();
    path.extend_from_slice(
        request
            .environment()
            .get("PATH")
            .unwrap_or(&[47, 98, 105, 110]),
    );
    for (name, value) in [
        (
            "REVERIE_SESSION_ID",
            scalar_text(request.session().as_str()),
        ),
        (
            "REVERIE_API_URL",
            scalar_text(reverie_core::worker_child::OFFICE_API_URL),
        ),
        ("PATH", text(&path)),
        ("NIX_REMOTE", scalar_text("local")),
        ("NIX_PATH", scalar_text("nixpkgs=flake:nixpkgs")),
    ] {
        let name = key(name);
        if let Some((_, old)) = fields.iter_mut().find(|(key, _)| *key == name) {
            *old = value;
        } else {
            fields.push((name, value));
        }
    }
    OrderedValue::object(fields)
}
