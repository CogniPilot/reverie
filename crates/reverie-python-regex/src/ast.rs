pub(crate) const IGNORE: u32 = 2;
pub(crate) const LOCALE: u32 = 4;
pub(crate) const MULTILINE: u32 = 8;
pub(crate) const DOTALL: u32 = 16;
pub(crate) const UNICODE: u32 = 32;
pub(crate) const VERBOSE: u32 = 64;
pub(crate) const ASCII: u32 = 256;
pub(crate) const TYPE_FLAGS: u32 = LOCALE | UNICODE | ASCII;
pub(crate) const MAX_REPEAT: u32 = u32::MAX;
// Actual CPython3.13.15 _sre.MAXGROUPS, not the dependency's wider data limit.
pub(crate) const MAX_GROUPS: usize = (u32::MAX as usize) / 4;
pub(crate) const MAX_WIDTH: u128 = 1 << 64;
pub(crate) type Sub = usize;
pub(crate) type Width = (u128, u128);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub(crate) enum Category {
    Digit,
    NotDigit,
    Space,
    NotSpace,
    Word,
    NotWord,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Anchor {
    Beginning,
    End,
    BeginningString,
    EndString,
    Boundary,
    NonBoundary,
}
#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub(crate) enum Member {
    Literal(u32),
    Range(u32, u32),
    Category(Category),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RepeatKind {
    Greedy,
    Lazy,
    Possessive,
}
/// Composite children are arena indices. Deep owner patterns cannot create a
/// recursive destructor or require an unchecked recursive AST walk.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Node {
    Literal(u32),
    NotLiteral(u32),
    Any,
    Class {
        negate: bool,
        members: Vec<Member>,
    },
    At(Anchor),
    Branch(Vec<Sub>),
    Group {
        number: Option<usize>,
        add: u32,
        remove: u32,
        body: Sub,
    },
    Atomic(Sub),
    Repeat {
        minimum: u32,
        maximum: u32,
        kind: RepeatKind,
        body: Sub,
    },
    Assert {
        negative: bool,
        behind: bool,
        body: Sub,
    },
    Reference(usize),
    Conditional {
        group: usize,
        yes: Sub,
        no: Option<Sub>,
    },
}
#[derive(Default, Debug)]
pub(crate) struct Pattern {
    pub nodes: Vec<Node>,
    pub width: Width,
}
#[derive(Debug)]
pub(crate) struct Parsed {
    pub arena: Vec<Pattern>,
    pub root: Sub,
    pub flags: u32,
    pub groups: Vec<Option<Width>>,
}
impl Parsed {
    pub(crate) fn new() -> Self {
        Self {
            arena: vec![Pattern::default()],
            root: 0,
            flags: IGNORE,
            groups: vec![None],
        }
    }
    pub(crate) fn allocate(&mut self) -> Sub {
        let index = self.arena.len();
        self.arena.push(Pattern::default());
        index
    }
    pub(crate) fn finish(&mut self, index: Sub) -> Width {
        let mut lo = 0;
        let mut hi = 0;
        for node in &self.arena[index].nodes {
            let width = self.node_width(node);
            lo = (lo + width.0).min(MAX_WIDTH);
            hi = (hi + width.1).min(MAX_WIDTH);
        }
        self.arena[index].width = (lo, hi);
        (lo, hi)
    }
    fn node_width(&self, node: &Node) -> Width {
        match node {
            Node::Literal(_) | Node::NotLiteral(_) | Node::Any | Node::Class { .. } => (1, 1),
            Node::Group { body, .. } | Node::Atomic(body) => self.arena[*body].width,
            Node::Branch(branches) => branches.iter().fold((MAX_WIDTH, 0), |(a, b), &sub| {
                let (lo, hi) = self.arena[sub].width;
                (a.min(lo), b.max(hi))
            }),
            Node::Repeat {
                minimum,
                maximum,
                body,
                ..
            } => {
                let (a, b) = self.arena[*body].width;
                (
                    a * u128::from(*minimum),
                    if *maximum == MAX_REPEAT && b > 0 {
                        MAX_WIDTH
                    } else {
                        b * u128::from(*maximum)
                    },
                )
            }
            Node::Reference(group) => self.groups[*group].expect("closed parsed group"),
            Node::Conditional { yes, no, .. } => {
                let (a, b) = self.arena[*yes].width;
                no.map_or((0, b), |sub| {
                    let (c, d) = self.arena[sub].width;
                    (a.min(c), b.max(d))
                })
            }
            Node::At(_) | Node::Assert { .. } => (0, 0),
        }
    }
}
