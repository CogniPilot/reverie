//! Shared configuration publication bytes, preserving the captured SID order.
use super::*;

pub(crate) fn publication_bytes(config: &EffectiveWorkerConfig) -> Vec<u8> {
    let Node::Object(fields) = &config.as_value().0 else {
        unreachable!("worker object");
    };
    let mut output = vec![b'{'];
    for (index, (name, value)) in fields.iter().enumerate() {
        if index != 0 {
            output.push(b',');
        }
        output.extend(compact_data(&Value(Node::String(name.clone()))));
        output.push(b':');
        if name == &Text("sessionResources".chars().map(u32::from).collect())
            && let Node::Object(resources) = &value.0
        {
            output.push(b'{');
            for (index, name) in config.session_resource_order().iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                let name = Text(name.codepoints().to_vec());
                output.extend(compact_data(&Value(Node::String(name.clone()))));
                output.push(b':');
                output.extend(compact_data(
                    resources
                        .get(&name)
                        .expect("captured session-resource order"),
                ));
            }
            output.push(b'}');
        } else {
            output.extend(compact_data(value));
        }
    }
    output.push(b'}');
    output
}
