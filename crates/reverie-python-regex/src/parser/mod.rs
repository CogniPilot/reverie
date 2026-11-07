//! Native Python str regex grammar, source order pinned to CPython3.13 _parser.
//! Arena nodes and an explicit group stack avoid recursive parsing/destruction.
mod class;
mod escape;
mod flags;
mod group;
use crate::{
    ast::*,
    cursor::{Cursor, Token},
    error::{RegexError, Result},
    facts,
};
use std::{collections::BTreeMap, sync::Arc};
#[derive(Clone, Copy)]
enum Kind {
    Root,
    Group {
        number: Option<usize>,
        add: u32,
        remove: u32,
        atomic: bool,
    },
    Assert {
        negative: bool,
        behind: bool,
        previous: Option<usize>,
    },
    Conditional(usize),
}
struct Frame {
    kind: Kind,
    branches: Vec<Sub>,
    start: usize,
    verbose: bool,
}
pub(crate) struct Parser {
    cursor: Cursor,
    parsed: Parsed,
    frames: Vec<Frame>,
    names: BTreeMap<Vec<u32>, usize>,
    lookbehind: Option<usize>,
    conditional_positions: Vec<(usize, usize)>,
}
impl Parser {
    pub(crate) fn parse(source: Arc<[u32]>) -> Result<Parsed> {
        let cursor = Cursor::new(source)?;
        let mut parser = Self {
            cursor,
            parsed: Parsed::new(),
            frames: vec![Frame {
                kind: Kind::Root,
                branches: vec![0],
                start: 0,
                verbose: false,
            }],
            names: BTreeMap::new(),
            lookbehind: None,
            conditional_positions: Vec::new(),
        };
        parser.body()?;
        if parser.parsed.flags & ASCII == 0 {
            parser.parsed.flags |= UNICODE;
        } else if parser.parsed.flags & UNICODE != 0 {
            return Err(
                parser.plain_error("ASCII and UNICODE flags are incompatible", "ValueError")
            );
        }
        if parser.cursor.next.is_some() {
            return Err(parser.cursor.error("unbalanced parenthesis", 0));
        }
        for &(group, position) in &parser.conditional_positions {
            if group >= parser.parsed.groups.len() {
                return Err(RegexError::new(
                    &parser.cursor.source,
                    &format!("invalid group reference {group}"),
                    Some(position),
                ));
            }
        }
        Ok(parser.parsed)
    }
    fn frame(&self) -> &Frame {
        self.frames.last().expect("root parser frame")
    }
    fn current(&self) -> Sub {
        *self.frame().branches.last().expect("current branch")
    }
    fn append(&mut self, node: Node) {
        let index = self.current();
        self.parsed.arena[index].nodes.push(node);
    }
    fn finish_current(&mut self) {
        let index = self.current();
        let nodes = std::mem::take(&mut self.parsed.arena[index].nodes);
        let mut flattened = Vec::new();
        for node in nodes {
            if let Node::Group {
                number: None,
                add: 0,
                remove: 0,
                body,
            } = node
            {
                flattened.extend_from_slice(&self.parsed.arena[body].nodes);
            } else {
                flattened.push(node);
            }
        }
        self.parsed.arena[index].nodes = flattened;
        self.parsed.finish(index);
    }
    fn body(&mut self) -> Result<()> {
        loop {
            let Some(token) = self.cursor.next else {
                self.check_end()?;
                break;
            };
            if token.is(b')') && self.frames.len() == 1 {
                break;
            }
            if token.is(b')') {
                self.cursor.take()?;
                self.close()?;
                continue;
            }
            if token.is(b'|') {
                self.next_branch()?;
                continue;
            }
            self.cursor.take()?;
            if self.skip_verbose(token)? {
                continue;
            }
            self.parse_token(token)?;
        }
        self.finish_current();
        let branches = self.frames.pop().unwrap().branches;
        self.parsed.root = self.combine(branches);
        Ok(())
    }
    fn check_end(&self) -> Result<()> {
        if self.frames.len() > 1 {
            return Err(RegexError::new(
                &self.cursor.source,
                "missing ), unterminated subpattern",
                Some(self.frame().start),
            ));
        }
        Ok(())
    }
    fn next_branch(&mut self) -> Result<()> {
        if matches!(self.frame().kind, Kind::Conditional(_)) && self.frame().branches.len() == 2 {
            return Err(self
                .cursor
                .error("conditional backref with more than two branches", 0));
        }
        self.cursor.take()?;
        self.finish_current();
        let next = self.parsed.allocate();
        self.frames.last_mut().unwrap().branches.push(next);
        Ok(())
    }
    fn skip_verbose(&mut self, token: Token) -> Result<bool> {
        if !self.frame().verbose {
            return Ok(false);
        }
        if matches!(token, Token::Char(9 | 10 | 11 | 12 | 13 | 32)) {
            return Ok(true);
        }
        if !token.is(b'#') {
            return Ok(false);
        }
        while let Some(next) = self.cursor.take()? {
            if next.is(b'\n') {
                break;
            }
        }
        Ok(true)
    }
    fn parse_token(&mut self, token: Token) -> Result<()> {
        match token {
            Token::Escape(point) => {
                let node = self.escape(point, false)?;
                self.append(node);
            }
            Token::Char(91) => {
                let node = self.class()?;
                self.append(node);
            }
            Token::Char(40) => self.group()?,
            Token::Char(46) => self.append(Node::Any),
            Token::Char(94) => self.append(Node::At(Anchor::Beginning)),
            Token::Char(36) => self.append(Node::At(Anchor::End)),
            Token::Char(point @ (42 | 43 | 63 | 123)) => self.repeat(point)?,
            Token::Char(point) => self.append(Node::Literal(point)),
        }
        Ok(())
    }
    fn combine(&mut self, branches: Vec<Sub>) -> Sub {
        if branches.len() == 1 {
            return branches[0];
        }
        let mut prefix = Vec::new();
        while let Some(node) = self.parsed.arena[branches[0]].nodes.get(prefix.len()) {
            if !branches
                .iter()
                .all(|&sub| self.parsed.arena[sub].nodes.get(prefix.len()) == Some(node))
            {
                break;
            }
            prefix.push(node.clone());
        }
        for &sub in &branches {
            self.parsed.arena[sub].nodes.drain(..prefix.len());
            self.parsed.finish(sub);
        }
        prefix.push(self.branch_tail(branches));
        let index = self.parsed.allocate();
        self.parsed.arena[index].nodes = prefix;
        self.parsed.finish(index);
        index
    }
    fn branch_tail(&self, branches: Vec<Sub>) -> Node {
        let set = branches
            .iter()
            .map(|&sub| match self.parsed.arena[sub].nodes.as_slice() {
                [Node::Literal(point)] => Some(vec![Member::Literal(*point)]),
                [
                    Node::Class {
                        negate: false,
                        members,
                    },
                ] => Some(members.clone()),
                _ => None,
            })
            .collect::<Option<Vec<_>>>();
        let Some(set) = set else {
            return Node::Branch(branches);
        };
        let mut seen = std::collections::HashSet::new();
        let members = set
            .into_iter()
            .flatten()
            .filter(|member| seen.insert(member.clone()))
            .collect();
        Node::Class {
            negate: false,
            members,
        }
    }
    fn close(&mut self) -> Result<()> {
        self.finish_current();
        let frame = self.frames.pop().unwrap();
        let node = match frame.kind {
            Kind::Conditional(group) => Node::Conditional {
                group,
                yes: frame.branches[0],
                no: frame.branches.get(1).copied(),
            },
            Kind::Group {
                number,
                add,
                remove,
                atomic,
            } => {
                let body = self.combine(frame.branches);
                if let Some(group) = number {
                    self.parsed.groups[group] = Some(self.parsed.arena[body].width);
                }
                if atomic {
                    Node::Atomic(body)
                } else {
                    Node::Group {
                        number,
                        add,
                        remove,
                        body,
                    }
                }
            }
            Kind::Assert {
                negative,
                behind,
                previous,
            } => {
                if behind {
                    self.lookbehind = previous;
                }
                let body = self.combine(frame.branches);
                Node::Assert {
                    negative,
                    behind,
                    body,
                }
            }
            Kind::Root => unreachable!("root closed only at end"),
        };
        self.append(node);
        Ok(())
    }
    fn open(&mut self, kind: Kind, start: usize, verbose: bool) {
        let sub = self.parsed.allocate();
        self.frames.push(Frame {
            kind,
            branches: vec![sub],
            start,
            verbose,
        });
    }
    fn check_behind(&self, group: usize) -> Result<()> {
        if let Some(begin) = self.lookbehind {
            if self.parsed.groups.get(group).is_none_or(Option::is_none) {
                return Err(self.cursor.error("cannot refer to an open group", 0));
            }
            if group >= begin {
                return Err(self.cursor.error(
                    "cannot refer to group defined in the same lookbehind subpattern",
                    0,
                ));
            }
        }
        Ok(())
    }
    fn group_name(&self, name: &[u32], offset: usize) -> Result<()> {
        if facts::identifier(name) {
            Ok(())
        } else {
            Err(self.cursor.error(
                &format!("bad character in group name {}", facts::quoted(name)),
                name.len() + offset,
            ))
        }
    }
    fn plain_error(&self, text: &str, kind: &'static str) -> RegexError {
        let mut error = RegexError::new(&self.cursor.source, text, None);
        error.kind = kind;
        error
    }
    fn repeat(&mut self, point: u32) -> Result<()> {
        let here = self.cursor.position();
        let (minimum, maximum) = match point {
            63 => (0, 1),
            42 => (0, MAX_REPEAT),
            43 => (1, MAX_REPEAT),
            123 => {
                if self.cursor.next.is_some_and(|token| token.is(b'}')) {
                    self.append(Node::Literal(point));
                    return Ok(());
                }
                let lo = self
                    .cursor
                    .while_chars(usize::MAX, |cp| matches!(cp, 48..=57))?;
                let hi = if self.cursor.eat(b',')? {
                    self.cursor
                        .while_chars(usize::MAX, |cp| matches!(cp, 48..=57))?
                } else {
                    lo.clone()
                };
                if !self.cursor.eat(b'}')? {
                    self.append(Node::Literal(point));
                    self.cursor.seek(here)?;
                    return Ok(());
                }
                let minimum = if lo.is_empty() {
                    0
                } else {
                    self.repeat_number(&lo)?
                };
                let maximum = if hi.is_empty() {
                    MAX_REPEAT
                } else {
                    self.repeat_number(&hi)?
                };
                if maximum < minimum {
                    return Err(self.cursor.error(
                        "min repeat greater than max repeat",
                        self.cursor.position() - here,
                    ));
                }
                (minimum, maximum)
            }
            _ => unreachable!("repeat token"),
        };
        let index = self.current();
        let error_offset = self.cursor.position() - here + 1;
        let Some(item) = self.parsed.arena[index].nodes.last() else {
            return Err(self.cursor.error("nothing to repeat", error_offset));
        };
        if matches!(item, Node::At(_)) {
            return Err(self.cursor.error("nothing to repeat", error_offset));
        }
        if matches!(item, Node::Repeat { .. }) {
            return Err(self.cursor.error("multiple repeat", error_offset));
        }
        let item = self.parsed.arena[index].nodes.pop().unwrap();
        let body = if let Node::Group {
            number: None,
            add: 0,
            remove: 0,
            body,
        } = item
        {
            body
        } else {
            let body = self.parsed.allocate();
            self.parsed.arena[body].nodes.push(item);
            self.parsed.finish(body);
            body
        };
        let kind = if self.cursor.eat(b'?')? {
            RepeatKind::Lazy
        } else if self.cursor.eat(b'+')? {
            RepeatKind::Possessive
        } else {
            RepeatKind::Greedy
        };
        self.append(Node::Repeat {
            minimum,
            maximum,
            kind,
            body,
        });
        Ok(())
    }
    fn repeat_number(&self, points: &[u32]) -> Result<u32> {
        if points.len() > 4300 {
            return Err(self.plain_error(&format!("Exceeds the limit (4300 digits) for integer string conversion: value has {} digits; use sys.set_int_max_str_digits() to increase the limit",points.len()),"ValueError"));
        }
        let value = points.iter().try_fold(0u32, |value, &cp| {
            value.checked_mul(10)?.checked_add(cp - 48)
        });
        value
            .filter(|&value| value < MAX_REPEAT)
            .ok_or_else(|| self.plain_error("the repetition number is too large", "OverflowError"))
    }
}
