//! Named metadata selector only; the captured SID observation order survives.
use super::*;
impl EffectiveWorkerConfig {
    pub(crate) fn select_resource_actor(
        &mut self,
        path: &reverie_core::posix_path::PosixPath,
    ) -> Option<()> {
        let Node::Object(fields) = &mut self.0.0 else {
            return None;
        };
        let name = Text("resourceActorConfig".bytes().map(u32::from).collect());
        if fields.contains_key(&name) {
            return None;
        }
        fields.insert(name, Value(Node::String(Text(path.codepoints().to_vec()))));
        Some(())
    }
}
