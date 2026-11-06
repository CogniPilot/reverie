//! CPython 3.13's prefix selection is observable for scoped ASCII categories:
//! its eligible charset is emitted with OUTER flags. Preserve that exact rule.
use super::*;
fn combine(flags: u32, add: u32, remove: u32) -> u32 {
    (if add & TYPE_FLAGS != 0 {
        flags & !TYPE_FLAGS
    } else {
        flags
    } | add)
        & !remove
}
fn cased(point: u32, flags: u32) -> bool {
    flags & IGNORE != 0
        && if flags & UNICODE != 0 {
            facts::lower(point) != point || facts::upper(point) != point
        } else {
            matches!(point,65..=90|97..=122)
        }
}
fn literal_prefix(parsed: &Parsed) -> bool {
    let mut stack = vec![(parsed.root, 0, parsed.flags)];
    let mut any = false;
    while let Some((sub, index, flags)) = stack.pop() {
        let Some(node) = parsed.arena[sub].nodes.get(index) else {
            continue;
        };
        match node {
            Node::Literal(point) if !cased(*point, flags) => {
                any = true;
                stack.push((sub, index + 1, flags));
            }
            Node::Group {
                add, remove, body, ..
            } => {
                stack.push((sub, index + 1, flags));
                stack.push((*body, 0, combine(flags, *add, *remove)));
            }
            _ => return any,
        }
    }
    any
}
fn charset_prefix(parsed: &Parsed) -> Option<(bool, Vec<Member>)> {
    let (mut sub, mut flags) = (parsed.root, parsed.flags);
    loop {
        match parsed.arena[sub].nodes.first()? {
            Node::Group {
                add, remove, body, ..
            } => {
                sub = *body;
                flags = combine(flags, *add, *remove);
            }
            Node::Literal(point) if !cased(*point, flags) => {
                return Some((false, vec![Member::Literal(*point)]));
            }
            Node::Class { negate, members } => {
                if members.iter().any(|member| ineligible(member, flags)) {
                    return None;
                }
                return Some((*negate, members.clone()));
            }
            Node::Branch(branches) => {
                return branch_prefix(parsed, branches, flags).map(|members| (false, members));
            }
            _ => return None,
        }
    }
}
pub(super) fn compile(parsed: &Parsed) -> Vec<u32> {
    let (lo, hi) = parsed.arena[parsed.root].width;
    let bound = |value: u128| value.min(u128::from(u32::MAX)) as u32;
    let mut code = vec![Op::INFO as u32, 4, 0, bound(lo), bound(hi)];
    if lo == 0 || literal_prefix(parsed) {
        return code;
    }
    if let Some((negate, members)) = charset_prefix(parsed) {
        let mut set = Vec::new();
        super::class(&mut set, negate, &members, parsed.flags & !IGNORE);
        code[2] = 4;
        code.extend_from_slice(&set[2..]);
        code[1] = (code.len() - 1) as u32;
    }
    code
}

fn ineligible(member: &Member, flags: u32) -> bool {
    match *member {
        Member::Literal(point) => cased(point, flags),
        Member::Range(lo, hi) if flags & IGNORE != 0 => {
            hi > 65535 || (lo..=hi).any(|point| cased(point, flags))
        }
        _ => false,
    }
}
fn branch_prefix(parsed: &Parsed, branches: &[Sub], flags: u32) -> Option<Vec<Member>> {
    branches
        .iter()
        .map(|&branch| match parsed.arena[branch].nodes.first()? {
            Node::Literal(point) if !cased(*point, flags) => Some(Member::Literal(*point)),
            _ => None,
        })
        .collect()
}
