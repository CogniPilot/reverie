//! Owner approval-file rule DATA shared by the autoenv builder and launcher.
//! The caller owns decoding, universal-newline iteration and first-match order;
//! this parser supplies no filesystem approval, executable or effect authority.
use reverie_core::{PythonText, PythonTextRef, python_glob::PythonGlob};

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct ApprovalRuleError;
impl std::fmt::Display for ApprovalRuleError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(
            "matched autoenv rule requires a repository glob, flake attribute and command list",
        )
    }
}
impl std::error::Error for ApprovalRuleError {}
/// The first matching rule's selected attribute/commands, never an arbitrary
/// environment dictionary, native path or authorization token.
pub struct AutoenvApproval {
    attribute: PythonText,
    commands: Vec<PythonText>,
}
impl AutoenvApproval {
    pub fn from_line(
        line: PythonTextRef<'_>,
        repository: PythonTextRef<'_>,
    ) -> Result<Option<Self>, ApprovalRuleError> {
        let line = line.into_owned();
        let fields = line.split_whitespace().collect::<Vec<_>>();
        let Some(pattern) = fields.first() else {
            return Ok(None);
        };
        if pattern.codepoints().first() == Some(&35)
            || !PythonGlob::compile(*pattern).is_match(repository)
        {
            return Ok(None);
        }
        let attribute = fields.get(1).ok_or(ApprovalRuleError)?.into_owned();
        let commands = fields.get(2).ok_or(ApprovalRuleError)?.codepoints();
        let commands = commands
            .split(|&point| point == 44)
            .map(|points| PythonText::try_new(points.to_vec()).expect("checked field slice"))
            .collect();
        Ok(Some(Self {
            attribute,
            commands,
        }))
    }
    pub fn attribute(&self) -> PythonTextRef<'_> {
        self.attribute.as_text_ref()
    }
    pub fn commands(&self) -> &[PythonText] {
        &self.commands
    }
    pub fn allows_command(&self, command: PythonTextRef<'_>) -> bool {
        self.commands
            .iter()
            .any(|allowed| allowed.codepoints() == command.codepoints().as_ref())
    }
}
