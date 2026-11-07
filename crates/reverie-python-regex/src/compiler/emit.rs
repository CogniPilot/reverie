use super::*;
impl<'a> Compiler<'a> {
    pub(super) fn node(&mut self, node: &'a Node, flags: u32) -> Result<()> {
        match node {
            Node::Literal(point) => literal(&mut self.code, *point, false, flags),
            Node::NotLiteral(point) => literal(&mut self.code, *point, true, flags),
            Node::Any => self.code.push(if flags & DOTALL != 0 {
                Op::ANY_ALL
            } else {
                Op::ANY
            } as u32),
            Node::Class { negate, members } => class(&mut self.code, *negate, members, flags),
            Node::At(anchor) => self.anchor(*anchor, flags),
            Node::Reference(group) => self.reference(*group, flags),
            Node::Group {
                number,
                add,
                remove,
                body,
            } => self.group(*number, *add, *remove, *body, flags),
            Node::Atomic(body) => {
                self.code.push(Op::ATOMIC_GROUP as u32);
                let skip = self.code.len();
                self.code.push(0);
                self.tasks.push(Task::Patch(skip, 0));
                self.tasks.push(Task::Word(Op::SUCCESS as u32));
                self.tasks.push(Task::Sequence(*body, flags));
            }
            Node::Branch(branches) => {
                self.code.push(Op::BRANCH as u32);
                self.tasks
                    .push(Task::Branch(branches, 0, flags, Vec::new()));
            }
            Node::Repeat {
                minimum,
                maximum,
                kind,
                body,
            } => self.repeat(*minimum, *maximum, *kind, *body, flags),
            Node::Assert {
                negative,
                behind,
                body,
            } => self.assertion(*negative, *behind, *body, flags)?,
            Node::Conditional { group, yes, no } => {
                self.code.push(Op::GROUPREF_EXISTS as u32);
                self.code.push((*group - 1) as u32);
                let skip = self.code.len();
                self.code.push(0);
                self.tasks.push(Task::ConditionalEnd(skip, *no, flags));
                self.tasks.push(Task::Sequence(*yes, flags));
            }
        }
        Ok(())
    }
    fn anchor(&mut self, anchor: Anchor, flags: u32) {
        self.code.push(Op::AT as u32);
        self.code.push(match anchor {
            Anchor::Beginning if flags & MULTILINE != 0 => At::BEGINNING_LINE,
            Anchor::Beginning => At::BEGINNING,
            Anchor::End if flags & MULTILINE != 0 => At::END_LINE,
            Anchor::End => At::END,
            Anchor::BeginningString => At::BEGINNING_STRING,
            Anchor::EndString => At::END_STRING,
            Anchor::Boundary if flags & UNICODE != 0 => At::UNI_BOUNDARY,
            Anchor::Boundary => At::BOUNDARY,
            Anchor::NonBoundary if flags & UNICODE != 0 => At::UNI_NON_BOUNDARY,
            Anchor::NonBoundary => At::NON_BOUNDARY,
        } as u32);
    }
    fn reference(&mut self, group: usize, flags: u32) {
        self.code.push(if flags & IGNORE == 0 {
            Op::GROUPREF
        } else if flags & UNICODE != 0 {
            Op::GROUPREF_UNI_IGNORE
        } else {
            Op::GROUPREF_IGNORE
        } as u32);
        self.code.push((group - 1) as u32);
    }
    fn group(&mut self, number: Option<usize>, add: u32, remove: u32, body: Sub, flags: u32) {
        let flags = if add & TYPE_FLAGS != 0 {
            flags & !TYPE_FLAGS
        } else {
            flags
        };
        let flags = (flags | add) & !remove;
        if let Some(number) = number {
            self.code.push(Op::MARK as u32);
            self.code.push((2 * (number - 1)) as u32);
            self.tasks.push(Task::Word((2 * (number - 1) + 1) as u32));
            self.tasks.push(Task::Word(Op::MARK as u32));
        }
        self.tasks.push(Task::Sequence(body, flags));
    }
    fn repeat(&mut self, minimum: u32, maximum: u32, kind: RepeatKind, body: Sub, flags: u32) {
        let simple = matches!(
            self.parsed.arena[body].nodes.as_slice(),
            [Node::Literal(_) | Node::NotLiteral(_) | Node::Any | Node::Class { .. }]
        );
        let opcode = match (kind, simple) {
            (RepeatKind::Greedy, true) => Op::REPEAT_ONE,
            (RepeatKind::Lazy, true) => Op::MIN_REPEAT_ONE,
            (RepeatKind::Possessive, true) => Op::POSSESSIVE_REPEAT_ONE,
            (RepeatKind::Possessive, false) => Op::POSSESSIVE_REPEAT,
            _ => Op::REPEAT,
        };
        self.code.extend([opcode as u32, 0, minimum, maximum]);
        let skip = self.code.len() - 3;
        if simple {
            self.tasks.push(Task::Patch(skip, 0));
            self.tasks.push(Task::Word(Op::SUCCESS as u32));
        } else {
            self.tasks.push(Task::Word(match kind {
                RepeatKind::Greedy => Op::MAX_UNTIL,
                RepeatKind::Lazy => Op::MIN_UNTIL,
                RepeatKind::Possessive => Op::SUCCESS,
            } as u32));
            self.tasks.push(Task::Patch(skip, 0));
        }
        self.tasks.push(Task::Sequence(body, flags));
    }
    fn assertion(&mut self, negative: bool, behind: bool, body: Sub, flags: u32) -> Result<()> {
        let width = if behind {
            let (lo, hi) = self.parsed.arena[body].width;
            if lo > u128::from(u32::MAX) {
                return Err(RegexError::new(self.source, "looks too much behind", None));
            }
            if lo != hi {
                return Err(RegexError::new(
                    self.source,
                    "look-behind requires fixed-width pattern",
                    None,
                ));
            }
            lo as u32
        } else {
            0
        };
        self.code
            .push(if negative { Op::ASSERT_NOT } else { Op::ASSERT } as u32);
        let skip = self.code.len();
        self.code.extend([0, width]);
        self.tasks.push(Task::Patch(skip, 0));
        self.tasks.push(Task::Word(Op::SUCCESS as u32));
        self.tasks.push(Task::Sequence(body, flags));
        Ok(())
    }
}
